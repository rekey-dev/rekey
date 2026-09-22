/**
 * License management routes.
 *
 * Tenant operator surface (under /api/v1/tenant/applications/:id/licenses)
 * lives in tenant-applications.routes.ts to keep all tenant-scoped
 * resources in one place.
 *
 * THIS file ships the public verification endpoint
 * (POST /api/v1/licenses/verify), that's what the customer's software
 * calls at startup with the raw license key + a machine fingerprint, and
 * the signed-in end-user's own list (GET /api/v1/users/me/licenses).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { licensesService } from './licenses.service.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { licenseRateLimit } from '../../lib/rate-limit.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { resolveSelfBillingSubject } from '../billing/self-subject.js';

const VerifyBody = z.object({
  key: z.string().min(1).max(256),
  machineFingerprint: z.string().min(1).max(256),
  label: z.string().min(1).max(120).optional(),
});

const DeactivateBody = z.object({
  key: z.string().min(1).max(256),
  machineFingerprint: z.string().min(1).max(256),
});

export async function licensesPublicRoutes(app: FastifyInstance): Promise<void> {
  // A desktop/client app verifies its own license at startup with no backend,
  // so this accepts the publishable key (or a secret key). The actual
  // entitlement bearer is the license `key` in the body, the publishable key
  // only identifies which Application's licenses to check against.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireBillingEnabled);
  // /verify both reads license state and writes activation rows; treat as
  // billing:write since licenses are a billing-tier artefact (publishable
  // requests are pre-authorized by route membership).
  app.addHook('onRequest', requireScope('billing:write'));

  // Per (application, IP) bucket for both licence routes, see
  // licenseRateLimitKey. 60/min covers an office launching at nine and bounds
  // a key guesser to one attempt a second per address.
  const LICENSE_RATE_LIMIT = licenseRateLimit(60);

  app.post(
    '/verify',
    {
      config: { rateLimit: LICENSE_RATE_LIMIT },
      schema: {
        tags: ['Public · Licenses'],
        summary: 'Verify a license key + record an activation for this machine',
        description:
          'Returns { ok, license?, reason? }. `ok=false` is intentional for invalid licenses, ' +
          'the customer\'s software loops on this and we want a deterministic body, not an HTTP error.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['key', 'machineFingerprint'],
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 256 },
            machineFingerprint: { type: 'string', minLength: 1, maxLength: 256 },
            label: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
        response: {
          // Always 200, `verify()` never throws for an invalid/expired/
          // revoked/seats-exhausted license; `ok: false` + `reason` IS the
          // deterministic failure body the description promises.
          200: ok(ref('LicenseVerifyResult'), 'Verification outcome, check `ok` before `license`.'),
          ...errs({
            400: 'VALIDATION_ERROR — the body failed schema validation.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID — the secret key is missing, malformed, or ' +
              'unknown/revoked/expired; or PUBLISHABLE_KEY_INVALID — the publishable key is ' +
              'unknown or has rotated out.',
            403:
              "IP_NOT_ALLOWED — caller IP outside the secret key's allowlist; or " +
              "ORIGIN_NOT_ALLOWED — the Origin is outside the publishable key's CORS allowlist; " +
              'or BILLING_DISABLED — billing is not enabled for this application; or ' +
              'API_KEY_SCOPE_INSUFFICIENT — the secret key lacks the `billing:write` scope.',
            429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const body = VerifyBody.parse(req.body);
      const result = await licensesService.verify({
        applicationId: req.application!.id,
        rawKey: body.key,
        machineFingerprint: body.machineFingerprint,
        ...(body.label !== undefined && { label: body.label }),
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/deactivate',
    {
      config: { rateLimit: LICENSE_RATE_LIMIT },
      schema: {
        tags: ['Public · Licenses'],
        summary: 'Give back the seat this machine holds on a license',
        description:
          'The counterpart to /verify: the customer\'s software calls it before a re-image or on ' +
          'uninstall so the seat is free for the next machine. Same deterministic body, `ok=false` ' +
          '+ `reason` for an unknown, revoked or expired key, never an HTTP error. Idempotent: ' +
          '`released` is false when the machine held no seat. A later /verify from the same ' +
          'machine reactivates the seat in place if one is free.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['key', 'machineFingerprint'],
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 256 },
            machineFingerprint: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: ok(ref('LicenseDeactivateResult'), 'Outcome, check `ok` before `released`.'),
          ...errs({
            400: 'VALIDATION_ERROR — the body failed schema validation.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID — the secret key is missing, malformed, or ' +
              'unknown/revoked/expired; or PUBLISHABLE_KEY_INVALID — the publishable key is ' +
              'unknown or has rotated out.',
            403:
              "IP_NOT_ALLOWED — caller IP outside the secret key's allowlist; or " +
              "ORIGIN_NOT_ALLOWED — the Origin is outside the publishable key's CORS allowlist; " +
              'or BILLING_DISABLED — billing is not enabled for this application; or ' +
              'API_KEY_SCOPE_INSUFFICIENT — the secret key lacks the `billing:write` scope.',
            429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const body = DeactivateBody.parse(req.body);
      const result = await licensesService.deactivate({
        applicationId: req.application!.id,
        rawKey: body.key,
        machineFingerprint: body.machineFingerprint,
      });
      return { success: true, data: result };
    },
  );
}

/**
 * `GET /api/v1/users/me/licenses`: the signed-in end-user's own licences.
 *
 * Same credential tier as the other self-service billing reads
 * (`GET /billing/entitlements`): publishable or secret key plus the user
 * token, `billing:read` for a secret key, billing enabled. The token is the
 * authorizer and there is no id to aim it at anyone else.
 */
const SelfLicensesQuery = PaginationQuery.extend({ organizationId: z.string().min(1).optional() });

export async function licensesSelfRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireBillingEnabled);
  app.addHook('onRequest', requireScope('billing:read'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Licenses'],
        summary: "List the current end-user's licences",
        description:
          'Every licence issued to the caller (personal, and any they bought for a team), newest ' +
          'first. In an org-billed Application (`billingSubject: "org"`) whose session acts for an ' +
          'organization the caller still belongs to, the licences pooled to that organization are ' +
          'included too, whoever bought them: the same subject `include=entitlements` resolves. ' +
          'Pass `?organizationId=` (member-only) to include that organization\'s pooled licences ' +
          'instead. No raw keys: only a hash of each key is stored, so a row carries its display ' +
          "`keyPrefix`. The operator's licence `metadata` is not on this surface.",
        security: [{ publishableKey: [], userToken: [] }, { apiKey: [], userToken: [] }],
        querystring: {
          type: 'object',
          properties: { organizationId: { type: 'string' }, ...paginationJsonSchema },
        },
        response: {
          200: okPage(ref('EndUserLicense'), "A page of the end-user's licences."),
          ...errs({
            400: 'BAD_REQUEST: `limit` or `offset` is out of range.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID: the Application key is ' +
              'missing or unknown; or USER_TOKEN_MISSING / USER_TOKEN_INVALID / ' +
              'USER_TOKEN_WRONG_APPLICATION / IMPERSONATION_SESSION_ENDED: the user JWT is missing, ' +
              'invalid, issued by another Application, or its impersonation has ended.',
            403:
              "IP_NOT_ALLOWED: a secret-key caller's IP is outside the allowlist; or " +
              "ORIGIN_NOT_ALLOWED: a publishable-key caller's Origin is outside the CORS allowlist; " +
              'or BILLING_DISABLED: billing is not enabled for this application; or ' +
              'API_KEY_SCOPE_INSUFFICIENT: the secret key lacks `billing:read`; or ' +
              'ORGANIZATION_NOT_MEMBER: `organizationId` names an organization the caller is not a ' +
              'member of.',
            429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const q = SelfLicensesQuery.parse(req.query);
      const { take, skip } = parsePagination(q);
      // The rule every self read shares: an explicit organization is
      // member-only, otherwise the session's subject. The caller's own licences
      // are listed either way; an organization adds its pool.
      const subject = await resolveSelfBillingSubject(req, q.organizationId);
      const organizationId = 'organizationId' in subject ? subject.organizationId : undefined;
      const { items, total } = await licensesService.listForEndUser(req.application!.id, req.endUser!.id, {
        ...(organizationId && { organizationId }),
        take,
        skip,
      });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );
}
