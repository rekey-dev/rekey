/**
 * Public credits endpoints, the customer's backend reads balances, draws
 * credits down and, with the elevated `credits:grant` scope, grants them
 * (server-to-server, secret key). `creditsSelfRoutes` at the bottom is the
 * signed-in end-user's own ledger read.
 *
 * Subject: pass `endUserId` for a personal balance OR `organizationId` for a
 * shared org pool (exactly one). The secret key already scopes to the
 * Application, so the backend may manage any subject inside its own app.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KeyGrantCreditsRequestSchema, MAX_KEY_CREDIT_GRANT } from '@rekey.dev/shared-types';
import { creditsService, type CreditSubjectInput } from './credits.service.js';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { requireApiKey, requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';
import { positiveBoundedInt } from '../../lib/bounded-int.js';
import { assertMetadataWithinLimit } from '../../lib/metadata-limit.js';
import { recordSecurityEventIn, requestContext } from '../../lib/security-events.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { paged } from '../../lib/pagination.js';
import { resolveSelfBillingSubject } from '../billing/self-subject.js';

/**
 * Auth/gate errors shared by every route in this file: `requireApiKey`
 * (secret key only, the publishable key is rejected outright) +
 * `requireBillingEnabled`, then the per-route `requireScope`.
 */
const READ_GATE_ERRORS = {
  401:
    'API_KEY_MISSING — no Authorization header; or API_KEY_INVALID — the presented credential ' +
    'is not a valid Application secret key, or is unknown/revoked/expired.',
  403:
    "IP_NOT_ALLOWED — caller IP outside the key's allowlist; or BILLING_DISABLED — billing is " +
    'not enabled for this application; or API_KEY_SCOPE_INSUFFICIENT — the key lacks the ' +
    '`billing:read` scope.',
  429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
} as const;

const WRITE_GATE_ERRORS = {
  401: READ_GATE_ERRORS[401],
  403: READ_GATE_ERRORS[403].replace('billing:read', 'billing:write'),
  429: READ_GATE_ERRORS[429],
} as const;

/** `resolveSubject` refuses an org/end-user id that doesn't belong to this Application. */
const SUBJECT_NOT_FOUND =
  'ORGANIZATION_NOT_FOUND — `organizationId` does not name an organization in this ' +
  'application; or END_USER_NOT_FOUND — `endUserId` does not name an end-user in this application.';

/**
 * Prefix on the ledger idempotency key of a `POST /grant`. The caller's key is
 * stored as `api-grant:<key>`, so it can never match a consume, a usage
 * charge (`usage:`) or a purchase (`purchase:`) on the same subject.
 */
export const KEY_GRANT_IDEMPOTENCY_PREFIX = 'api-grant:';

const subjectFields = {
  endUserId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
};
const exactlyOneSubject = (d: {
  endUserId?: string | undefined;
  organizationId?: string | undefined;
}): boolean => Boolean(d.endUserId) !== Boolean(d.organizationId);
const subjectRefine = { message: 'Pass exactly one of endUserId or organizationId.' };

const BalanceQuery = z.object(subjectFields).refine(exactlyOneSubject, subjectRefine);
const LedgerQuery = z
  .object({
    ...subjectFields,
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .refine(exactlyOneSubject, subjectRefine);
const ConsumeBody = z
  .object({
    ...subjectFields,
    amount: positiveBoundedInt(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(exactlyOneSubject, subjectRefine);

/** Validate + resolve the subject against the calling Application. */
async function resolveSubject(
  applicationId: string,
  input: { endUserId?: string | undefined; organizationId?: string | undefined },
): Promise<{ subject: CreditSubjectInput; label: { endUserId?: string; organizationId?: string } }> {
  if (input.organizationId) {
    const org = await prisma.organization.findFirst({
      where: { id: input.organizationId, applicationId },
      select: { id: true },
    });
    if (!org) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_NOT_FOUND',
        message: `Organization "${input.organizationId}" not found in this Application.`,
        fix: 'Pass the id of an organization in the Application this key is scoped to.',
      });
    }
    return { subject: { organizationId: input.organizationId }, label: { organizationId: input.organizationId } };
  }
  const eu = await prisma.endUser.findFirst({
    where: { id: input.endUserId!, applicationId },
    select: { id: true },
  });
  if (!eu) {
    throw new RekeyError({
      statusCode: 404,
      code: 'END_USER_NOT_FOUND',
      message: `End-user "${input.endUserId}" not found in this Application.`,
      fix: 'Pass the id of an end-user that belongs to the Application this key names.',
    });
  }
  return { subject: { endUserId: input.endUserId! }, label: { endUserId: input.endUserId! } };
}

export async function creditsPublicRoutes(app: FastifyInstance): Promise<void> {
  // Server-side only: `requireApiKey` rejects the publishable key outright.
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireBillingEnabled);
  // Scope is per-route, not per-plugin: the reads take `billing:read` so a
  // deliberately-narrow read-only key works. `billing:write` implies
  // `billing:read` in SCOPE_IMPLICATIONS, so existing write keys are unaffected.

  app.get(
    '/balance',
    {
      onRequest: requireScope('billing:read'),
      schema: {
        tags: ['Public · Credits'],
        summary: "Get a subject's current credit balance (end-user or org)",
        description:
          'Accepts a narrow `billing:read` key, since this only reads. A `billing:write` ' +
          'key also works, because write implies read. Secret key only; the publishable ' +
          'key is rejected.',
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          properties: { endUserId: { type: 'string' }, organizationId: { type: 'string' } },
        },
        response: {
          200: ok(ref('CreditBalance'), "The subject's current credit balance."),
          ...errs({
            400: 'VALIDATION_ERROR — pass exactly one of `endUserId` or `organizationId`.',
            ...READ_GATE_ERRORS,
            404: SUBJECT_NOT_FOUND,
          }),
        },
      },
    },
    async (req) => {
      const applicationId = req.application!.id;
      const { subject, label } = await resolveSubject(applicationId, BalanceQuery.parse(req.query));
      const balance = await creditsService.getBalance(applicationId, subject);
      return { success: true, data: { applicationId, ...label, balance } };
    },
  );

  app.post(
    '/consume',
    {
      onRequest: requireScope('billing:write'),
      // Generic Idempotency-Key HEADER support (scoped to the Application).
      // Distinct from the body-level `idempotencyKey` below, which dedupes at
      // the credit-ledger level and keeps working unchanged, the header is
      // the route-agnostic mechanism, the body field the ledger-native one.
      config: { idempotency: true },
      schema: {
        tags: ['Public · Credits'],
        summary: 'Deduct credits from a subject (idempotent)',
        description:
          'Atomically debits `amount` from the end-user or org pool. 402 CREDITS_INSUFFICIENT ' +
          'when too low. Pass `idempotencyKey` (or an `Idempotency-Key` header) to make retries safe.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['amount'],
          properties: {
            endUserId: { type: 'string' },
            organizationId: { type: 'string' },
            amount: { type: 'integer', minimum: 1, maximum: 2147483647 },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          200: ok(ref('ConsumeCreditsResult'), 'The balance after the drawdown.'),
          ...errs({
            400:
              'VALIDATION_ERROR — pass exactly one of `endUserId` or `organizationId`; or ' +
              'IDEMPOTENCY_KEY_INVALID — the Idempotency-Key header is empty or exceeds 200 ' +
              'characters; or METADATA_TOO_LARGE — `metadata` exceeds the 16KB limit.',
            ...WRITE_GATE_ERRORS,
            402: 'CREDITS_INSUFFICIENT — the balance is below `amount`.',
            404: SUBJECT_NOT_FOUND,
            409:
              'IDEMPOTENCY_KEY_IN_FLIGHT — a request with this Idempotency-Key is still being ' +
              'processed; or IDEMPOTENCY_KEY_REUSED — the key was already used for a different ' +
              'method, path, or body.',
          }),
        },
      },
    },
    async (req) => {
      const applicationId = req.application!.id;
      const body = ConsumeBody.parse(req.body);
      if (body.metadata) assertMetadataWithinLimit(body.metadata);
      const { subject } = await resolveSubject(applicationId, body);
      const result = await creditsService.consume({
        applicationId,
        ...subject,
        amount: body.amount,
        ...(body.idempotencyKey !== undefined && { idempotencyKey: body.idempotencyKey }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/grant',
    {
      // Elevated: `*` does not imply it, so no key that exists today can call
      // this until an operator mints one with `credits:grant` named.
      onRequest: requireScope('credits:grant'),
      config: { idempotency: true },
      schema: {
        tags: ['Public · Credits'],
        summary: 'Grant credits to a subject with the Application key (elevated scope)',
        description:
          'Adds `amount` credits to an end-user or an organization pool through the same ' +
          'ledger write as an operator grant from the panel, and records ' +
          '`app.credits_granted_by_api_key` in the security log naming the key.\n\n' +
          'Requires a secret key minted with the **`credits:grant`** scope named. `*` does not ' +
          'include it: `*` is the default on every key, and a scope that mints value is ' +
          'only ever held by a key someone chose to give it to.\n\n' +
          `\`amount\` is 1 to ${MAX_KEY_CREDIT_GRANT} per call. \`idempotencyKey\` is required ` +
          'and is scoped to the subject and to this route (it never matches a consume made ' +
          'under the same string): a repeat of the same grant returns the original entry ' +
          'with `applied: false` and grants nothing, and the same key with a different ' +
          '`amount` or `reason` is `409 CREDITS_IDEMPOTENCY_KEY_REUSED`. The ledger stores it ' +
          'as `api-grant:<key>`, which is what `credit.*` webhooks and `GET /credits/ledger` ' +
          'show. Removing credits is not possible here; use ' +
          '`POST /credits/consume`, or an operator ADJUST.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['amount', 'idempotencyKey'],
          properties: {
            endUserId: { type: 'string' },
            organizationId: { type: 'string' },
            amount: { type: 'integer', minimum: 1, maximum: MAX_KEY_CREDIT_GRANT },
            reason: { type: 'string', enum: ['GRANT', 'REFUND'], default: 'GRANT' },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: ok(ref('CreditGrantResult'), 'The ledger entry and the balance after it.'),
          ...errs({
            400:
              'VALIDATION_ERROR: pass exactly one of `endUserId` or `organizationId`, an ' +
              `\`amount\` from 1 to ${MAX_KEY_CREDIT_GRANT}, and an \`idempotencyKey\`; or ` +
              'IDEMPOTENCY_KEY_INVALID: the Idempotency-Key header is empty or exceeds 200 ' +
              'characters; or METADATA_TOO_LARGE: `metadata` exceeds the 16KB limit.',
            401: READ_GATE_ERRORS[401],
            403:
              "IP_NOT_ALLOWED: caller IP outside the key's allowlist; or BILLING_DISABLED: " +
              'billing is not enabled for this application; or API_KEY_SCOPE_INSUFFICIENT: the ' +
              'key was not minted with `credits:grant` (a `*` key does not hold it).',
            404: SUBJECT_NOT_FOUND,
            409:
              'IDEMPOTENCY_KEY_IN_FLIGHT: a request with this Idempotency-Key is still being ' +
              'processed; or IDEMPOTENCY_KEY_REUSED: the key was already used for a different ' +
              'method, path, or body; or CREDITS_IDEMPOTENCY_KEY_REUSED: the body ' +
              '`idempotencyKey` already names a grant to this subject with a different ' +
              '`amount` or `reason`.',
            429: READ_GATE_ERRORS[429],
          }),
        },
      },
    },
    async (req, reply) => {
      const applicationId = req.application!.id;
      const body = KeyGrantCreditsRequestSchema.refine(exactlyOneSubject, subjectRefine).parse(req.body);
      if (body.metadata) assertMetadataWithinLimit(body.metadata);
      const { subject, label } = await resolveSubject(applicationId, body);
      const apiKey = req.apiKey!;
      const result = await creditsService.grant({
        applicationId,
        ...subject,
        amount: body.amount,
        reason: body.reason,
        // Namespaced, as usage.record namespaces its debits: the ledger key is
        // unique per subject across EVERY writer, so a bare key would collide
        // with a consume the backend made under the same string (a lead id)
        // or a system key, and the grant would silently answer "already done".
        idempotencyKey: `${KEY_GRANT_IDEMPOTENCY_PREFIX}${body.idempotencyKey}`,
        // Same key, different amount or reason: 409, not a silent no-op.
        strictReplay: true,
        ...(body.description !== undefined && { description: body.description }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
        // Written in the grant's transaction, so an applied grant always has
        // its audit row (and a failed audit write fails the grant). A replay
        // writes no entry, so it is not audited twice.
        afterEntry: (tx, entry) =>
          recordSecurityEventIn(tx, {
            type: 'app.credits_granted_by_api_key',
            actorType: 'system',
            actorId: apiKey.id,
            tenantId: req.application!.tenantId,
            applicationId,
            ...requestContext(req),
            metadata: {
              apiKeyId: apiKey.id,
              apiKeyName: apiKey.name,
              keyPrefix: apiKey.keyPrefix,
              ...label,
              amount: body.amount,
              reason: body.reason,
              idempotencyKey: body.idempotencyKey,
              ledgerEntryId: entry.id,
              balance: entry.balanceAfter,
            },
          }),
      });
      return reply.status(201).send({ success: true, data: result });
    },
  );

  app.get(
    '/ledger',
    {
      onRequest: requireScope('billing:read'),
      schema: {
        tags: ['Public · Credits'],
        summary: "List a subject's recent credit ledger entries (newest first)",
        description:
          'Accepts a narrow `billing:read` key, like `GET /balance`. Secret key only; the ' +
          'publishable key is rejected.',
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          properties: {
            endUserId: { type: 'string' },
            organizationId: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
          },
        },
        response: {
          200: okPage(ref('CreditLedgerEntry'), "A page of the subject's credit ledger entries, newest first."),
          ...errs({
            400: 'VALIDATION_ERROR — pass exactly one of `endUserId` or `organizationId`.',
            ...READ_GATE_ERRORS,
            404: SUBJECT_NOT_FOUND,
          }),
        },
      },
    },
    async (req) => {
      const applicationId = req.application!.id;
      const q = LedgerQuery.parse(req.query);
      const { subject } = await resolveSubject(applicationId, q);
      // The service clamps to 1..200 / >=0; mirror the clamp here so `page`
      // reports the window that was actually served.
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
      const offset = Math.max(q.offset ?? 0, 0);
      const [entries, total] = await Promise.all([
        creditsService.listLedger(applicationId, subject, { limit, offset }),
        creditsService.countLedger(applicationId, subject),
      ]);
      return { success: true, data: paged(entries, total, limit, offset) };
    },
  );
}

const SelfLedgerQuery = z.object({
  organizationId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** The `requireUserSession` failures, after the key gates. */
const USER_TOKEN_ERRORS =
  'USER_TOKEN_MISSING: no X-Rekey-User-Token header; USER_TOKEN_INVALID: the user token is ' +
  'invalid or expired; USER_TOKEN_WRONG_APPLICATION: the token was issued for a different ' +
  'Application; IMPERSONATION_SESSION_ENDED: the impersonation behind this token has ended.';

/**
 * The signed-in end-user's own credit reads. A separate plugin because the
 * routes above are secret-key only for the whole plugin (`requireApiKey` as a
 * plugin hook), and these are for a browser holding the publishable key and
 * the user's token, as `GET /billing/entitlements` is. The token, not the key,
 * decides whose ledger is read, so no subject parameter names an end-user.
 */
export async function creditsSelfRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/me/ledger',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:read'), requireUserSession],
      schema: {
        tags: ['Public · Credits'],
        summary: "Page through the signed-in end-user's own credit ledger (newest first)",
        description:
          "The token holder's personal ledger. In an Application that bills organizations " +
          "(`billingSubject: \"org\"`) it is the session's active organization's pool instead, " +
          'while the caller is still a member. Pass `?organizationId=` (member-only) to read a ' +
          'specific organization\'s pool. Entries omit `metadata`, which the operator and your ' +
          'backend write for their own use; `GET /credits/ledger` with a secret key returns it.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: {
          type: 'object',
          properties: {
            organizationId: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0, maximum: 1000000 },
          },
        },
        response: {
          200: okPage(ref('SelfCreditLedgerEntry'), "A page of the caller's credit ledger, newest first."),
          ...errs({
            400: 'VALIDATION_ERROR: the querystring failed schema validation.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID: the Application key ' +
              `is missing or unknown; or ${USER_TOKEN_ERRORS}`,
            403:
              "IP_NOT_ALLOWED / ORIGIN_NOT_ALLOWED: outside the key's allowlist; or " +
              'BILLING_DISABLED; or API_KEY_SCOPE_INSUFFICIENT: a secret key lacks `billing:read`; ' +
              'or ORGANIZATION_NOT_MEMBER: `organizationId` names an organization the caller is ' +
              'not a member of.',
            429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const q = SelfLedgerQuery.parse(req.query);
      const subject = await resolveSelfBillingSubject(req, q.organizationId);
      const applicationId = req.application!.id;
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
      const offset = Math.max(q.offset ?? 0, 0);
      const [entries, total] = await Promise.all([
        creditsService.listLedger(applicationId, subject, { limit, offset }),
        creditsService.countLedger(applicationId, subject),
      ]);
      // Shaped field by field: the raw row also carries the idempotency key,
      // the subject key and `metadata`, none of which is the end-user's to see.
      const items = entries.map((e) => ({
        id: e.id,
        delta: e.delta,
        reason: e.reason,
        balanceAfter: e.balanceAfter,
        description: e.description,
        createdAt: e.createdAt.toISOString(),
      }));
      return { success: true, data: paged(items, total, limit, offset) };
    },
  );
}
