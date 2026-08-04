/**
 * OpenAPI response modelling — shared components + the envelope helpers every
 * route's `schema.response` is built from.
 *
 * ## Why this file exists
 *
 * Until 2.0.0-rc.3 the published document (`/docs/json`, mirrored to
 * the published `openapi.json`) declared **zero** response schemas:
 * 275 of 276 operations said nothing but `"200": {"description": "Default
 * Response"}`. Two independent external audits called that "half a contract" —
 * you could not generate a typed client, the `{success, data}` envelope was
 * undocumented, and no error shape appeared anywhere. This module is the fix:
 * declare the envelope and the recurring domain objects **once**, reference
 * them everywhere.
 *
 * ## How to use it from a route
 *
 * ```ts
 * import { ok, okPage, errs, ref } from '../../lib/openapi.js';
 *
 * app.get('/:id', {
 *   schema: {
 *     tags: ['Admin · Applications'],
 *     summary: 'Get an application by id',
 *     response: {
 *       200: ok(ref('Application'), 'The application.'),
 *       ...errs({
 *         401: 'UNAUTHORIZED — missing or invalid super-admin key.',
 *         404: 'APPLICATION_NOT_FOUND — no application with that id.',
 *       }),
 *     },
 *   },
 * }, handler);
 * ```
 *
 * Rules of thumb:
 *   - `ok(x)`      — `{success: true, data: x}`.
 *   - `okPage(x)`  — `{success: true, data: {items: x[], page: PageMeta}}`.
 *     Use this for **every** list endpoint. A bare array response is a defect
 *     (it silently truncates with nothing saying so) and the contract test
 *     rejects it.
 *   - `errs({...})` — only the statuses this operation can *actually* return.
 *     Read the handler. A blanket 400/401/500 on everything is what the audit
 *     complained about; it documents nothing.
 *
 * ## Components are documentation of a floor, not a ceiling
 *
 * No component sets `additionalProperties: false`. Each says "these fields are
 * present and have these types"; a response may carry more. That is deliberate:
 * many handlers return a Prisma row that is a superset of the SDK DTO, and
 * claiming exhaustiveness we have not verified would be the same class of lie
 * the audit found.
 *
 * ## Response schemas here are documentation, not serialisation
 *
 * Fastify normally compiles `schema.response` with fast-json-stringify, which
 * **drops** any field the schema does not declare. Switching 276 previously
 * unschema'd operations onto that in one change would silently strip fields
 * from live responses wherever a schema is even slightly incomplete — a much
 * worse outcome than a sparse document. So `registerOpenApiComponents()`
 * installs a pass-through serializer: `JSON.stringify`, exactly what Fastify
 * already did for every one of these routes when they had no response schema.
 * Runtime behaviour is therefore byte-identical to before this change; only the
 * published document gained content.
 *
 * The guard against drift is the test suite, not the serializer — see
 * `test/openapi-contract.test.ts`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AccessConfigSchema,
  ApiKeyDtoSchema,
  ApplicationDtoSchema,
  AuthConfigSchema,
  AuthResultDtoSchema,
  BillingConfigSchema,
  BillingProviderInfoDtoSchema,
  BillingStatsDtoSchema,
  CheckoutResultDtoSchema,
  ConsumeCreditsResultDtoSchema,
  CouponDtoSchema,
  CreditBalanceDtoSchema,
  CreditLedgerEntryDtoSchema,
  EndUserDtoSchema,
  JwkRsaPublicSchema,
  JwksDtoSchema,
  LicenseDtoSchema,
  LicenseVerifyResultDtoSchema,
  MfaChallengeResultDtoSchema,
  MonthlyRevenuePointSchema,
  OAuthAuthServerMetadataSchema,
  OAuthIntrospectionResponseSchema,
  OrganizationDtoSchema,
  OrganizationInvitationDtoSchema,
  OrganizationMemberDtoSchema,
  OrganizationWithRoleDtoSchema,
  PlanDtoSchema,
  PublicCouponDtoSchema,
  RetryWebhookDeliveryResultDtoSchema,
  SecurityEventDtoSchema,
  SignInOutcomeDtoSchema,
  SubscriptionDtoSchema,
  TenantEndUserDtoSchema,
  TenantLimitsSchema,
  TenantPaymentDtoSchema,
  UsageAggregateDtoSchema,
  UsageRecordDtoSchema,
  ValidateCouponResultDtoSchema,
  WebhookDeliveryDtoSchema,
  WebhookEndpointDtoSchema,
} from '@rekey.dev/shared-types';

/** A JSON Schema fragment. Deliberately loose — these are data, not types. */
export type JsonSchema = Record<string, unknown>;

/**
 * Convert a zod schema to an OpenAPI-3.0-flavoured JSON Schema.
 *
 * `target: 'openApi3'` because the published document is `openapi: 3.0.3`,
 * where nullability is `nullable: true` rather than a `type` array — a
 * draft-07 `type: ['string','null']` would not validate.
 *
 * `$refStrategy: 'none'` inlines everything. The alternative emits a
 * `definitions` block with internal `$ref`s that Fastify's shared-schema store
 * would have to resolve per component; inlining keeps each registered component
 * self-contained, which is what `components.schemas` wants anyway.
 */
function fromZod(schema: z.ZodTypeAny): JsonSchema {
  const out = zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    errorMessages: false,
  }) as JsonSchema;
  // zod-to-json-schema stamps `$schema` (and sometimes `additionalProperties:
  // false` from `.strict()`); neither belongs in an OpenAPI component.
  delete out.$schema;
  return openClosedObjects(out);
}

/**
 * Strip every `additionalProperties: false` from a generated schema.
 *
 * The module header says these components describe **a floor, not a ceiling**,
 * and the `fromZod` comment above says it deletes the closed flag. It did not:
 * it deleted `$schema` only, and 40 of the 55 components shipped closed. Two
 * consequences, both real and both found by a schema audit:
 *
 *   1. **Responses that cannot validate.** `GET /users/me` and `GET /auth/me`
 *      are declared `allOf: [EndUser, {required: [activeOrganizationId]}]`.
 *      With `EndUser` closed, no object satisfies that: carrying the field
 *      makes it "additional", omitting it breaks "required". The declaration
 *      was unsatisfiable by construction. Both handlers also return `role`,
 *      `updatedAt`, `erasedAt` and `erasedBy`, none of which `EndUserDto`
 *      declares.
 *   2. **Every other closed-schema violation** in one move, rather than
 *      chasing handlers that legitimately return a superset of an SDK DTO.
 *      `GET /tenant/applications/:id` returns 15 fields the `Application`
 *      component does not declare (measured, not estimated).
 *
 * Only `false` is removed. `additionalProperties: true` is meaningful — it is
 * how `metadata` bags say "any keys" — and is left alone.
 *
 * This does NOT weaken anything at runtime: the serializer is `JSON.stringify`
 * (see the module header), so these schemas have never gated a byte.
 */
function openClosedObjects(node: unknown): JsonSchema {
  if (Array.isArray(node)) {
    return node.map(openClosedObjects) as unknown as JsonSchema;
  }
  if (node === null || typeof node !== 'object') return node as JsonSchema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'additionalProperties' && value === false) continue;
    out[key] = openClosedObjects(value);
  }
  return out as JsonSchema;
}

// ---------------------------------------------------------------------------
// Envelope + infrastructure components
// ---------------------------------------------------------------------------

/**
 * The error object every failure carries. Mirrors what `rekeyErrorHandler`
 * (lib/error.ts) actually emits — verified against all five of its branches:
 * `RekeyError`, `ZodError`, Fastify-native 4xx, dependency-outage 503, and the
 * catch-all 500 — plus the two envelopes app.ts writes inline (the NUL-byte
 * 400 and the `ROUTE_NOT_FOUND` 404).
 */
const RekeyErrorObject: JsonSchema = {
  type: 'object',
  description: 'The error detail. `code` is stable and safe to switch on.',
  properties: {
    code: {
      type: 'string',
      description:
        'Stable machine-readable identifier — safe to `switch` on. Never a framework ' +
        'code: Fastify\'s own `FST_ERR_*` identifiers are mapped onto documented codes ' +
        '(see lib/error.ts).',
      example: 'PLAN_NOT_FOUND',
    },
    message: { type: 'string', description: 'Human-readable explanation.' },
    fix: {
      type: 'string',
      description:
        'Concrete remediation. Present on essentially every error — read this first when ' +
        'debugging, it is the most useful field for both humans and agents.',
    },
    docs: {
      type: 'string',
      format: 'uri',
      description: 'Long-form explanation for this `code`, when one exists.',
    },
    retryAfterSeconds: {
      type: 'integer',
      description:
        'Present on 429 and on the 503 dependency-outage envelope. Mirrored in the ' +
        '`Retry-After` response header.',
    },
    issues: {
      type: 'array',
      description:
        'Present only on `VALIDATION_ERROR` (400): the per-field failures, capped at 10.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Dotted field path. Empty string for a whole-body failure.',
          },
          message: { type: 'string' },
        },
        required: ['path', 'message'],
      },
    },
    requestId: {
      type: 'string',
      description:
        'Server-assigned id for this request, also returned in the `X-Request-Id` header ' +
        'on every response. Quote it to support to find the matching log line.',
    },
  },
  required: ['code', 'message', 'requestId'],
};

/** `{success: false, error: {...}}` — the shape of every failed response. */
const ErrorResponseSchema: JsonSchema = {
  type: 'object',
  description:
    'The failure envelope. Every non-2xx response from this API has this shape, including ' +
    'the 404 for an unrouted path.',
  properties: {
    success: { type: 'boolean', enum: [false], description: 'Always `false`.' },
    error: RekeyErrorObject,
  },
  required: ['success', 'error'],
};

/**
 * Offset-pagination metadata. Matches `pageMeta()` in lib/pagination.ts
 * exactly — `{total, limit, offset, hasMore}`.
 */
const PageMetaSchema: JsonSchema = {
  type: 'object',
  description: 'Offset-pagination metadata for a list response.',
  properties: {
    total: {
      type: 'integer',
      description: 'Total rows matching the query, ignoring `limit`/`offset`.',
    },
    limit: { type: 'integer', description: 'Rows requested for this window (capped at 100).' },
    offset: { type: 'integer', description: 'Rows skipped before this window.' },
    hasMore: {
      type: 'boolean',
      description: 'True when `offset + limit < total` — i.e. another page exists.',
    },
  },
  required: ['total', 'limit', 'offset', 'hasMore'],
};

/** `{ok: true}` — the body of the handful of endpoints that confirm and return nothing. */
const OkFlagSchema: JsonSchema = {
  type: 'object',
  description: 'A bare acknowledgement — the operation succeeded and returns no entity.',
  properties: { ok: { type: 'boolean', enum: [true] } },
  required: ['ok'],
};

// ---------------------------------------------------------------------------
// Domain components
// ---------------------------------------------------------------------------

/**
 * Hand-written components for shapes `@rekey.dev/shared-types` does not model.
 *
 * Everything that *is* modelled there is derived instead (see `ZOD_COMPONENTS`)
 * so the document cannot drift from the types the SDKs compile against.
 *
 * **Every one of these was written against the service that produces it**, not
 * from the endpoint's name. The first draft of this block was written from
 * plausible field names and four separate reviewers caught it inventing fields
 * that do not exist (`Passkey.deviceType`, `Tenant.slug`, `UsageMeter.aggregation`,
 * `Operator.mfaEnabled`) — a named component that describes nothing real is
 * worse than no component, because a client generator turns it into a type
 * someone then writes code against. If you add one here, open the service and
 * copy the row type.
 */
const HAND_WRITTEN_COMPONENTS: Record<string, JsonSchema> = {
  ErrorResponse: ErrorResponseSchema,
  RekeyError: RekeyErrorObject,
  PageMeta: PageMetaSchema,
  OkFlag: OkFlagSchema,

  /**
   * A workspace (the `Tenant` table). The operator-facing unit of isolation.
   * Source: `tenantsService.list/get/create` return the Prisma row verbatim.
   * Note there is deliberately **no `slug`** — workspaces are addressed by id.
   */
  Tenant: {
    type: 'object',
    description: 'A workspace. Owns Applications, operators, and billing.',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      ownerEmail: {
        type: 'string',
        description:
          'The address captured when this workspace was created. NOT updated by an ownership ' +
          'transfer — the canonical owner is the membership with `role: OWNER`.',
      },
      limits: {
        description:
          'Per-workspace resource ceilings, set by a super-admin only. `null` means unlimited, ' +
          'as does an absent key inside the object.',
        nullable: true,
        allOf: [{ $ref: 'TenantLimits#' }],
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'name', 'ownerEmail', 'createdAt', 'updatedAt'],
  },

  /**
   * An operator — a human with a login on the panel.
   * Source: `PublicTenantUser` = the `TenantUser` row minus `passwordHash`.
   */
  Operator: {
    type: 'object',
    description: 'A workspace operator (panel user). Distinct from an end user of your app.',
    properties: {
      id: { type: 'string' },
      email: { type: 'string', format: 'email' },
      name: { type: 'string', nullable: true },
      emailVerified: { type: 'boolean' },
      failedSignInAttempts: { type: 'integer' },
      lockedUntil: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'Set while the account is locked out after repeated failed sign-ins.',
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'email', 'emailVerified', 'createdAt', 'updatedAt'],
  },

  /** One entry of an operator session's `memberships`. Source: `MembershipSummary`. */
  MembershipSummary: {
    type: 'object',
    description: 'A workspace this operator belongs to, and their role in it.',
    properties: {
      tenantId: { type: 'string' },
      tenantName: { type: 'string' },
      role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
    },
    required: ['tenantId', 'tenantName', 'role'],
  },

  /**
   * A per-Application grant on a MEMBER membership.
   * Source: `MemberGrantRow` (tenant-workspaces.service.ts).
   */
  MemberGrant: {
    type: 'object',
    description:
      'A per-Application access grant. Only meaningful for MEMBER memberships — OWNER/ADMIN ' +
      'have implicit access to every Application, and a MEMBER with an empty list is in ' +
      'legacy mode (read-only on every Application).',
    properties: {
      applicationId: { type: 'string' },
      applicationName: { type: 'string' },
      applicationSlug: { type: 'string' },
      role: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['applicationId', 'applicationName', 'applicationSlug', 'role', 'createdAt'],
  },

  /**
   * An operator's membership of one workspace.
   * Source: `MemberRow` (tenant-workspaces.service.ts) — note `membershipId` /
   * `tenantUserId` / `joinedAt`, not `id` / `userId` / `createdAt`.
   */
  WorkspaceMember: {
    type: 'object',
    description: "An operator's membership of a workspace, with their live role and grants.",
    properties: {
      membershipId: { type: 'string' },
      tenantUserId: { type: 'string' },
      email: { type: 'string', format: 'email' },
      name: { type: 'string', nullable: true },
      role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
      joinedAt: { type: 'string', format: 'date-time' },
      grants: { type: 'array', items: { $ref: 'MemberGrant#' } },
    },
    required: ['membershipId', 'tenantUserId', 'email', 'role', 'joinedAt', 'grants'],
  },

  /**
   * An invitation to join a workspace.
   * Source: `InvitationRow` (tenant-workspaces.service.ts). `status` is
   * **derived** at read time, not a column — there are no `acceptedAt` /
   * `revokedAt` fields on the wire.
   */
  WorkspaceInvitation: {
    type: 'object',
    description: 'An invitation for an operator to join a workspace.',
    properties: {
      id: { type: 'string' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
      expiresAt: { type: 'string', format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      invitedById: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'accepted', 'expired', 'revoked'],
        description: 'Derived at read time. Precedence: revoked > accepted > expired > pending.',
      },
    },
    required: ['id', 'email', 'role', 'expiresAt', 'createdAt', 'invitedById', 'status'],
  },

  /**
   * An operator personal access token (`rp_op_…`) — metadata only.
   * Source: `shapeOperatorToken` (tenant-auth.routes.ts).
   */
  OperatorToken: {
    type: 'object',
    description:
      'An operator personal access token. The raw `rp_op_…` secret is returned once, by the ' +
      'mint endpoint only — never by a list or a get.',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      tokenPrefix: {
        type: 'string',
        description: 'First characters of the token ("rp_op_abcd…"), for display only.',
      },
      scopes: {
        type: 'array',
        items: { type: 'string' },
        description: "Default-deny. `['read']` when none were requested.",
      },
      tenantId: { type: 'string', description: 'The workspace this PAT acts in. Bound at mint.' },
      expiresAt: { type: 'string', format: 'date-time', nullable: true },
      lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
      revokedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: [
      'id',
      'name',
      'tokenPrefix',
      'scopes',
      'tenantId',
      'expiresAt',
      'lastUsedAt',
      'revokedAt',
      'createdAt',
    ],
  },

  /**
   * The GDPR/DSAR data-export document.
   *
   * `GET /tenant/applications/{id}/end-users/{euid}/export` declared
   * `{"type": "string"}` — because it is documented as a file download — and
   * returns a JSON **object**. A client generator turned that into
   * `Promise<string>`; the schema audit flagged it as describing something the
   * endpoint has never returned.
   *
   * Written field-for-field against `EndUserExportDocument` in
   * `@rekey.dev/shared-types` (a plain interface, not a zod schema, so it
   * cannot be derived) and cross-checked against the handler's `document`
   * literal. Deliberately NOT the `{success, data}` envelope: the handler sends
   * the bare document under a `Content-Disposition: attachment` header.
   *
   * Row arrays are described as objects and left open. That is the same
   * "floor, not ceiling" rule the rest of this file follows, and it is the
   * honest level of detail here: several of these sections are projections
   * assembled inline in the handler rather than named DTOs.
   */
  EndUserExport: {
    type: 'object',
    description:
      'Everything Rekey stores about one end-user, as one downloadable JSON document ' +
      '(GDPR Art. 15 / CCPA). Never contains credential material: no password hash, no ' +
      'token hashes, no MFA secrets or backup codes, no license key hash, no passkey ' +
      'public keys. Several sections are capped server-side — `notes` says which.',
    properties: {
      exportVersion: { type: 'integer', description: '1 today. Bumps when the shape changes.' },
      exportedAt: { type: 'string', format: 'date-time' },
      applicationId: { type: 'string' },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Human-readable caveats — which sections hit a cap, what is excluded.',
      },
      endUser: {
        type: 'object',
        description:
          'The profile. `failedSignInAttempts` and `lockedUntil` come from the Redis ' +
          'brute-force limiter, not from columns on the row.',
        properties: {
          id: { type: 'string' },
          applicationId: { type: 'string' },
          email: { type: 'string', format: 'email' },
          emailVerified: { type: 'boolean' },
          role: { type: 'string' },
          metadata: { type: 'object', nullable: true, additionalProperties: true },
          failedSignInAttempts: { type: 'integer' },
          lockedUntil: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'applicationId', 'email', 'emailVerified', 'createdAt', 'updatedAt'],
      },
      oauthIdentities: { type: 'array', items: { type: 'object' } },
      sessions: {
        type: 'array',
        description: 'Session METADATA only — never token material. Capped, newest first.',
        items: { type: 'object' },
      },
      mfa: {
        type: 'object',
        nullable: true,
        description: 'Enrollment metadata only. Null when the user has no MFA credential.',
        properties: {
          enrolled: { type: 'boolean' },
          enrolledAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['enrolled', 'enrolledAt', 'createdAt', 'updatedAt'],
      },
      passkeys: { type: 'array', items: { type: 'object' } },
      organizationMemberships: { type: 'array', items: { type: 'object' } },
      subscriptions: { type: 'array', items: { type: 'object' } },
      payments: { type: 'array', items: { type: 'object' } },
      licenses: {
        type: 'array',
        description: 'License metadata — `keyPrefix` only, never the key hash.',
        items: { type: 'object' },
      },
      creditBalance: {
        type: 'integer',
        description: "Sum across the user's credit balances in this Application.",
      },
      creditLedger: { type: 'array', items: { $ref: 'CreditLedgerEntry#' } },
      usageRecords: { type: 'array', items: { type: 'object' } },
      securityEvents: { type: 'array', items: { type: 'object' } },
      impersonations: { type: 'array', items: { type: 'object' } },
    },
    required: [
      'exportVersion',
      'exportedAt',
      'applicationId',
      'notes',
      'endUser',
      'oauthIdentities',
      'sessions',
      'mfa',
      'passkeys',
      'organizationMemberships',
      'subscriptions',
      'payments',
      'licenses',
      'creditBalance',
      'creditLedger',
      'usageRecords',
      'securityEvents',
      'impersonations',
    ],
  },

  /** A metered-usage definition on an Application. Source: the `UsageMeter` Prisma row. */
  UsageMeter: {
    type: 'object',
    description: 'A usage meter — the unit a USAGE-kind plan bills against.',
    properties: {
      id: { type: 'string' },
      applicationId: { type: 'string' },
      slug: { type: 'string' },
      name: { type: 'string' },
      unit: { type: 'string', description: 'What one record counts (e.g. `tokens`, `requests`).' },
      active: { type: 'boolean' },
      metadata: { type: 'object', additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'applicationId', 'slug', 'name', 'unit', 'active', 'createdAt'],
  },

  /**
   * One logged inbound API request. Source: `ApiRequestLogRow` (lib/request-log.ts).
   *
   * `routePath` is the route PATTERN (`/api/v1/tenant/applications/:id`), never
   * the concrete URL — no path-param PII, no cardinality blowup. The table is
   * a capped convenience tail kept by a periodic pruner, not a billing-grade
   * audit trail, so a page `total` counts what survives pruning.
   */
  ApiRequestLog: {
    type: 'object',
    description: 'One logged API request. Best-effort, capped per app/operator by a pruner.',
    properties: {
      id: { type: 'string' },
      method: { type: 'string' },
      routePath: {
        type: 'string',
        description: 'The matched route pattern, e.g. `/api/v1/tenant/applications/:id`.',
      },
      statusCode: { type: 'integer' },
      durationMs: { type: 'integer' },
      applicationId: {
        type: 'string',
        nullable: true,
        description: 'Set for API-key traffic. Null for operator/panel and anonymous requests.',
      },
      tenantId: { type: 'string', nullable: true },
      operatorUserId: {
        type: 'string',
        nullable: true,
        description: 'Set for operator/panel traffic. Null for API-key and anonymous requests.',
      },
      ip: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'method', 'routePath', 'statusCode', 'durationMs', 'createdAt'],
  },

  /** One outbound email the deployment attempted. Source: `EmailLogRow` (email.service.ts). */
  EmailLog: {
    type: 'object',
    description: 'One attempted outbound email.',
    properties: {
      id: { type: 'string' },
      applicationId: {
        type: 'string',
        nullable: true,
        description: 'Null for workspace system mail (operator invites, operator magic links).',
      },
      toAddress: { type: 'string' },
      subject: { type: 'string' },
      eventKey: {
        type: 'string',
        nullable: true,
        description: 'Which template fired (e.g. `verify_email`). Null for ad-hoc sends.',
      },
      via: { type: 'string', description: 'The transport that carried it (e.g. `resend`, `smtp`).' },
      status: { type: 'string', enum: ['sent', 'error', 'no_transport'] },
      messageId: { type: 'string', nullable: true },
      error: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'toAddress', 'subject', 'via', 'status', 'createdAt'],
  },

  /**
   * A registered passkey (WebAuthn credential).
   * Source: `PasskeyRow` — the field is `deviceName`; there is no `deviceType`
   * or `backedUp` on the wire.
   */
  Passkey: {
    type: 'object',
    description: 'A registered WebAuthn credential. Public metadata only, never key material.',
    properties: {
      id: { type: 'string' },
      credentialId: { type: 'string' },
      deviceName: {
        type: 'string',
        nullable: true,
        description: 'Label supplied at registration time. Null when the client sent none.',
      },
      lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'credentialId', 'deviceName', 'lastUsedAt', 'createdAt'],
  },

  /**
   * An operator session. Source: `AuthSessionResult` (tenant-auth.service.ts) —
   * the token pair plus the workspace it is scoped to and the memberships the
   * panel's workspace switcher renders.
   */
  OperatorSession: {
    type: 'object',
    description: 'An operator session — a token pair scoped to one workspace.',
    properties: {
      user: { $ref: 'Operator#' },
      memberships: {
        type: 'array',
        items: { $ref: 'MembershipSummary#' },
        description: 'Every workspace this operator belongs to, at sign-in time.',
      },
      activeTenantId: { type: 'string', description: 'The workspace this token pair is scoped to.' },
      activeRole: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
      accessToken: { type: 'string', description: 'Short-lived. Send as `Authorization: Bearer`.' },
      accessTokenExpiresAt: { type: 'string', format: 'date-time' },
      refreshToken: { type: 'string' },
      refreshTokenExpiresAt: { type: 'string', format: 'date-time' },
    },
    required: [
      'user',
      'memberships',
      'activeTenantId',
      'activeRole',
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
    ],
  },
};

/**
 * Components derived from `@rekey.dev/shared-types`.
 *
 * These are the shapes the SDKs already compile against, so deriving keeps the
 * document and the types from drifting apart — change the zod schema and this
 * document changes with it.
 */
const ZOD_COMPONENTS: Record<string, z.ZodTypeAny> = {
  Application: ApplicationDtoSchema,
  ApiKey: ApiKeyDtoSchema,
  AuthConfig: AuthConfigSchema,
  BillingConfig: BillingConfigSchema,
  AccessConfig: AccessConfigSchema,
  TenantLimits: TenantLimitsSchema,

  EndUser: EndUserDtoSchema,
  TenantEndUser: TenantEndUserDtoSchema,
  AuthResult: AuthResultDtoSchema,
  MfaChallengeResult: MfaChallengeResultDtoSchema,
  SignInOutcome: SignInOutcomeDtoSchema,

  Plan: PlanDtoSchema,
  Subscription: SubscriptionDtoSchema,
  Payment: TenantPaymentDtoSchema,
  CheckoutResult: CheckoutResultDtoSchema,
  Coupon: CouponDtoSchema,
  PublicCoupon: PublicCouponDtoSchema,
  ValidateCouponResult: ValidateCouponResultDtoSchema,
  BillingProviderInfo: BillingProviderInfoDtoSchema,
  BillingStats: BillingStatsDtoSchema,
  MonthlyRevenuePoint: MonthlyRevenuePointSchema,

  License: LicenseDtoSchema,
  LicenseVerifyResult: LicenseVerifyResultDtoSchema,

  UsageRecord: UsageRecordDtoSchema,
  UsageAggregate: UsageAggregateDtoSchema,

  CreditBalance: CreditBalanceDtoSchema,
  CreditLedgerEntry: CreditLedgerEntryDtoSchema,
  ConsumeCreditsResult: ConsumeCreditsResultDtoSchema,

  Organization: OrganizationDtoSchema,
  OrganizationWithRole: OrganizationWithRoleDtoSchema,
  OrganizationMember: OrganizationMemberDtoSchema,
  OrganizationInvitation: OrganizationInvitationDtoSchema,

  WebhookEndpoint: WebhookEndpointDtoSchema,
  WebhookDelivery: WebhookDeliveryDtoSchema,
  RetryWebhookDeliveryResult: RetryWebhookDeliveryResultDtoSchema,

  SecurityEvent: SecurityEventDtoSchema,

  Jwks: JwksDtoSchema,
  JwkRsaPublic: JwkRsaPublicSchema,
  OAuthIntrospectionResponse: OAuthIntrospectionResponseSchema,
  OAuthAuthServerMetadata: OAuthAuthServerMetadataSchema,
};

/** Every component name a route may `ref()`. */
export const COMPONENT_NAMES = [
  ...Object.keys(HAND_WRITTEN_COMPONENTS),
  ...Object.keys(ZOD_COMPONENTS),
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

/** Build the full `components.schemas` map (also used by the contract test). */
export function buildComponents(): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = { ...HAND_WRITTEN_COMPONENTS };
  for (const [name, schema] of Object.entries(ZOD_COMPONENTS)) {
    out[name] = fromZod(schema);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers routes use
// ---------------------------------------------------------------------------

/**
 * Reference a registered component.
 *
 * The `Name#` form is Fastify's shared-schema syntax; `@fastify/swagger`
 * rewrites it to `#/components/schemas/Name` when it builds the document.
 */
export function ref(name: ComponentName): JsonSchema {
  return { $ref: `${name}#` };
}

/** `{success: true, data: <data>}` — the success envelope. */
export function ok(data: JsonSchema, description = 'Success.'): JsonSchema {
  return {
    description,
    type: 'object',
    properties: {
      success: { type: 'boolean', enum: [true], description: 'Always `true`.' },
      data,
    },
    required: ['success', 'data'],
  };
}

/**
 * `{success: true, data: {items: [...], page: PageMeta}}` — the list envelope.
 *
 * Use this for every collection endpoint. A bare `data: [...]` array cannot
 * report `total`, so a caller has no way to tell a full page from a truncated
 * one — which is exactly the defect the functional audit found on 17 list
 * operations.
 */
export function okPage(item: JsonSchema, description = 'A page of results.'): JsonSchema {
  return ok(
    {
      type: 'object',
      properties: {
        items: { type: 'array', items: item },
        page: ref('PageMeta'),
      },
      required: ['items', 'page'],
    },
    description,
  );
}

/**
 * `{success: true, data: [...]}` — an unpaginated array.
 *
 * Only for collections that are **bounded by construction** and cannot grow
 * with usage (a fixed provider list, an Application's OAuth providers, the
 * backup codes just minted). Anything that grows with tenant data must use
 * `okPage`.
 */
export function okArray(item: JsonSchema, description = 'Success.'): JsonSchema {
  return ok({ type: 'array', items: item }, description);
}

/** `{success: true, data: {ok: true}}` — acknowledgement, no entity. */
export function okFlag(description = 'Acknowledged.'): JsonSchema {
  return ok(ref('OkFlag'), description);
}

/**
 * Build the error responses for an operation.
 *
 * Pass **only** the statuses this operation can actually return, each with the
 * `code`s a caller will see:
 *
 * ```ts
 * ...errs({
 *   402: 'CREDITS_INSUFFICIENT — the balance is below `amount`.',
 *   409: 'PLAN_SLUG_TAKEN — another plan on this Application already uses that slug.',
 * })
 * ```
 */
export function errs(map: Record<number, string>): Record<number, JsonSchema> {
  const out: Record<number, JsonSchema> = {};
  for (const [status, description] of Object.entries(map)) {
    out[Number(status)] = { description, ...ref('ErrorResponse') };
  }
  return out;
}

/**
 * A non-JSON response (redirect, HTML, raw bytes).
 *
 * Some operations genuinely do not return the envelope — the OAuth authorize
 * endpoints 302 to the client's redirect URI, for instance. Declaring that is
 * still a contract; declaring `{success, data}` for it would be a lie.
 */
export function raw(description: string, contentType: string): JsonSchema {
  return { description, content: { [contentType]: { schema: { type: 'string' } } } };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register every component on the root instance and install the pass-through
 * serializer.
 *
 * Called from `registerSwagger()` (lib/swagger.ts) before any route plugin, so
 * every route can `$ref` these and every route inherits the serializer.
 *
 * **The serializer override is load-bearing.** See the module header: without
 * it, adding a response schema to a previously unschema'd route switches that
 * route onto fast-json-stringify, which drops undeclared fields. These schemas
 * describe a floor, not a ceiling, so that would silently truncate live
 * responses. `JSON.stringify` is precisely what Fastify used for these routes
 * before this change, so runtime output is unchanged.
 */
export function registerOpenApiComponents(app: FastifyInstance): void {
  for (const [name, schema] of Object.entries(buildComponents())) {
    app.addSchema({ $id: name, ...schema });
  }
  app.setSerializerCompiler(() => (data: unknown) => JSON.stringify(data));
}
