/**
 * `?include=` on `GET /api/v1/auth/me` and `GET /api/v1/users/me`.
 *
 * Lets a backend that authorises requests with Rekey access tokens answer who
 * the caller is, what they are entitled to, which device the session is bound
 * to and which organization it acts for, in the one call that already verifies
 * the session. Every value is produced by the service the dedicated route uses,
 * so the two answers cannot drift. With nothing included, nothing here runs.
 */

import type { Application } from '@prisma/client';
import { z } from 'zod';
import { ME_INCLUDE_VALUES, type MeInclude } from '@rekey.dev/shared-types';
import { ref, type JsonSchema } from '../../lib/openapi.js';
import { assertBillingEnabled } from '../../middleware/billing-enabled.js';
import { entitlementsService } from '../billing/entitlements.service.js';
import {
  NULLABLE_SUBSCRIPTION_SCHEMA,
  RESOLVED_ENTITLEMENTS_SCHEMA,
  billingSubjectOrganization,
  readCurrentSubscription,
} from '../billing/session-reads.js';
import { licensesService, SELF_LICENSE_INCLUDE_LIMIT } from '../licenses/licenses.service.js';
import { devicesService, forEndUser } from '../devices/devices.service.js';
import { organizationsService } from '../organizations/organizations.service.js';

const SUPPORTED = ME_INCLUDE_VALUES.join(', ');
const BILLING_INCLUDES: ReadonlyArray<MeInclude> = ['entitlements', 'subscription', 'licenses'];

function isMeInclude(value: string): value is MeInclude {
  return (ME_INCLUDE_VALUES as ReadonlyArray<string>).includes(value);
}

/**
 * Comma-separated, any order, duplicates ignored, blanks ignored. The repeated
 * form (`include=a&include=b`, what `URLSearchParams.append` builds) is merged
 * into the same list. An unknown value is refused rather than skipped, so a
 * typo cannot quietly return less than the caller built their authorisation
 * on. A ZodError renders as the standard 400 `VALIDATION_ERROR` with `issues`.
 */
const MeIncludeQuery = z.object({
  include: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((raw) =>
      [raw ?? []]
        .flat()
        .flatMap((part) => part.split(','))
        .map((v) => v.trim())
        .filter((v) => v !== ''),
    )
    .superRefine((values, ctx) => {
      for (const value of values) {
        if (!isMeInclude(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${value.slice(0, 40)}" is not a supported include value. Supported values: ${SUPPORTED}.`,
          });
        }
      }
    })
    .transform((values) => new Set(values.filter(isMeInclude))),
});

export function parseMeInclude(query: unknown): ReadonlySet<MeInclude> {
  return MeIncludeQuery.parse(query ?? {}).include;
}

/** Whether any requested value reads billing data (scope and billing-enabled gates). */
export function includesBilling(include: ReadonlySet<MeInclude>): boolean {
  return BILLING_INCLUDES.some((value) => include.has(value));
}

export interface MeIncludeSession {
  endUser: { id: string; applicationId: string };
  /** The token's `dev` claim. Already confirmed ACTIVE by the session checks. */
  deviceId: string | undefined;
  /** The organization the session names (`oid`), confirmed or not. */
  activeOrganizationId: string | null | undefined;
  /** Non-null only when the caller is a member of it with a usable role. */
  activeOrganizationRole: { role: string } | null;
  /** Loaded only when a billing value is requested. */
  loadApplication: () => Promise<Application>;
}

/**
 * The requested properties, each under its own name, and only those.
 *
 * Runs after every session check has passed, so an expired, revoked, erased or
 * frozen session has already been refused before any of this is read.
 */
export async function resolveMeIncludes(
  include: ReadonlySet<MeInclude>,
  session: MeIncludeSession,
): Promise<Record<string, unknown>> {
  if (include.size === 0) return {};
  const { endUser } = session;

  let application: Application | undefined;
  let billingOrganizationId: string | undefined;
  if (includesBilling(include)) {
    application = await session.loadApplication();
    assertBillingEnabled(application);
    billingOrganizationId = await billingSubjectOrganization(application, {
      applicationId: endUser.applicationId,
      endUserId: endUser.id,
      activeOrganizationId: session.activeOrganizationId,
    });
  }

  const reads: Record<MeInclude, () => Promise<unknown>> = {
    entitlements: () =>
      entitlementsService.resolveForEndUser(
        endUser.applicationId,
        endUser.id,
        billingOrganizationId ? { organizationId: billingOrganizationId } : undefined,
      ),
    subscription: () =>
      readCurrentSubscription(application!, endUser, {
        ...(billingOrganizationId && { organizationId: billingOrganizationId }),
      }),
    device: async () => {
      if (!session.deviceId) return null;
      // Scoped to this end-user and Application, so a `dev` claim naming anyone
      // else's device reads as no device at all.
      const device = await devicesService.find(endUser.applicationId, endUser.id, session.deviceId);
      return device && forEndUser(device);
    },
    organization: () => readActiveOrganization(session),
    licenses: async () => {
      const { items, total } = await licensesService.listForEndUser(endUser.applicationId, endUser.id, {
        ...(billingOrganizationId && { organizationId: billingOrganizationId }),
        take: SELF_LICENSE_INCLUDE_LIMIT,
        skip: 0,
      });
      // Capped, so the cap is said out loud rather than read as "that is all".
      return { items, truncated: total > items.length };
    },
  };

  const requested = ME_INCLUDE_VALUES.filter((value) => include.has(value));
  const values = await Promise.all(requested.map((value) => reads[value]()));
  return Object.fromEntries(requested.map((value, i) => [value, values[i]]));
}

async function readActiveOrganization(session: MeIncludeSession): Promise<unknown> {
  if (!session.activeOrganizationId || !session.activeOrganizationRole) return null;
  try {
    return await organizationsService.get({
      application: { id: session.endUser.applicationId },
      endUserId: session.endUser.id,
      organizationId: session.activeOrganizationId,
    });
  } catch (err) {
    // Membership ended or the role was disabled between the role lookup and
    // this read. Same answer the role lookup would now give: no organization.
    const code = (err as { code?: unknown }).code;
    if (code === 'ORGANIZATION_NOT_MEMBER' || code === 'ORGANIZATION_ROLE_DISABLED') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

export const ME_INCLUDE_QUERYSTRING: JsonSchema = {
  type: 'object',
  properties: {
    include: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description:
        `Comma-separated extras to add to the response, any order, duplicates ignored: ${SUPPORTED}. ` +
        'Each adds one top-level property of the same name. Omitted or empty, the response and ' +
        'the work done are unchanged. The repeated form (`include=a&include=b`) is accepted ' +
        'too. An unknown value is a 400 VALIDATION_ERROR. ' +
        'Example: `include=entitlements,device`.',
    },
  },
};

/** The optional properties `include` adds, one per value. */
export const ME_INCLUDED_PROPERTIES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    entitlements: {
      ...RESOLVED_ENTITLEMENTS_SCHEMA,
      description:
        'With `include=entitlements`. The same object GET /billing/entitlements/for-user returns ' +
        "for the Application's billing subject: in an org-billed Application " +
        "(`billingSubject: \"org\"`) the active organization's view while the caller is still a " +
        "member of it, otherwise the end-user's own. Every kind: FEATURE flags, CREDIT balance, " +
        'LICENSE and USAGE rows.',
    },
    device: {
      nullable: true,
      allOf: [ref('EndUserDevice')],
      description:
        "With `include=device`. The device named by the token's `dev` claim, or null when the " +
        'session is not device-bound. A session whose device was released or blocked is refused ' +
        'with 401 USER_TOKEN_INVALID before this is read, so a returned device is ACTIVE.',
    },
    subscription: {
      ...NULLABLE_SUBSCRIPTION_SCHEMA,
      description:
        'With `include=subscription`. What GET /billing/subscription returns for the same billing ' +
        'subject as `entitlements` (with `?organizationId=` in the org case), or null when there ' +
        'is no live or pending subscription.',
    },
    organization: {
      nullable: true,
      allOf: [ref('OrganizationWithRole')],
      description:
        "With `include=organization`. The session's active organization with the caller's role " +
        'and base role in it, or null when there is none or membership lapsed.',
    },
    licenses: {
      type: 'object',
      description:
        'With `include=licenses`. `items` is the first 100 rows of GET /users/me/licenses: the ' +
        'caller\'s own licences, plus the active organization\'s in an org-billed Application ' +
        '(the same subject as `entitlements`), newest first. `truncated` is true when there are ' +
        'more; page through GET /users/me/licenses for the rest. No raw keys: only the hash is ' +
        'stored, so each row carries its display `keyPrefix`.',
      properties: {
        items: { type: 'array', items: ref('EndUserLicense') },
        truncated: { type: 'boolean' },
      },
      required: ['items', 'truncated'],
    },
  },
};

export const ME_INCLUDE_ERRORS = {
  400:
    'VALIDATION_ERROR: `include` names a value other than ' +
    `${SUPPORTED}; the message lists the supported values.`,
  403:
    'BILLING_DISABLED: `include` asked for entitlements, subscription or licenses on an Application ' +
    'with billing turned off.',
} as const;

/**
 * The scope a secret key needs for each value on `/users/me`, the scope of the
 * dedicated route that already serves it. `device` has none beyond the
 * route's own `auth:read`.
 */
export const ME_INCLUDE_SCOPES: Partial<Record<MeInclude, string>> = {
  entitlements: 'billing:read',
  subscription: 'billing:read',
  // GET /users/me/organizations/:id, which reads with `auth:read`. Kept named
  // so the two stay in step if that route's scope ever changes again.
  organization: 'auth:read',
  // GET /users/me/licenses.
  licenses: 'billing:read',
};
