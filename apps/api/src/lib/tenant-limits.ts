/**
 * Per-workspace (Tenant) resource limits — read + enforcement.
 *
 * A workspace can carry optional ceilings in `Tenant.limits` (jsonb, shape =
 * `TenantLimitsSchema` in @rekey.dev/shared-types). Two writers, both
 * deployment-level: the super-admin endpoint
 * (PUT /api/v1/admin/tenants/:id/limits) and the `DEFAULT_TENANT_LIMITS`
 * env var, which stamps a starting value on every workspace this deployment
 * creates (see `resolveNewTenantLimits` below). A workspace operator can read
 * their own via the panel surface but cannot raise them.
 *
 * **Null / absent means unlimited.** That is the default for every row,
 * including every row that existed before this feature — a self-host
 * deployment that never touches limits behaves exactly as it always did.
 *
 * This is a mechanism, not a pricing model. Rekey attaches no plan, tier, or
 * price to these numbers; a multi-team self-host uses them to stop one
 * workspace consuming the whole deployment, and anything that derives them
 * from a subscription lives outside this codebase.
 *
 * ## What is enforced
 *
 * `maxProductionApps` gates the CREATION of new Applications whose
 * `environment` is PRODUCTION. STAGING and DEVELOPMENT are never counted and
 * never blocked, so a workspace sitting at its ceiling can still spin up as
 * many test environments as it wants. `Application.environment` is write-once
 * (set at create, never updated), so there is no promote-a-dev-app path around
 * it — that immutability is what makes counting at creation sufficient.
 *
 * `maxActiveEndUsers` gates the CREATION of new end-users only, counted
 * tenant-wide (summed across every Application the Tenant owns, not
 * per-Application). Two rules follow from that, and both are load-bearing:
 *
 *   1. **Existing end-users are never locked out.** Sign-in, refresh, MFA,
 *      password reset — untouched. This is an auth product; a workspace going
 *      over its ceiling must never strand people who already have accounts.
 *   2. **Erased (tombstoned) users don't count.** `erasedAt != null` rows are
 *      retained only for FK integrity behind retained financial rows (see
 *      docs/data-erasure.md); they are not people, so they don't consume quota.
 *
 * ## Atomicity guarantee (deliberate, and deliberately weak)
 *
 * The check is check-then-act: count, then create, with no lock between them.
 * What we guarantee is that the count is **exact and tenant-wide at the moment
 * of the check**. What we do NOT guarantee is a hard ceiling under
 * concurrency — N sign-ups racing at the boundary can each observe
 * `count < max` and all succeed, overshooting by at most the number of
 * in-flight creates.
 *
 * That trade is intentional. Closing it would mean a tenant-level advisory
 * lock or a SERIALIZABLE transaction around every sign-up, i.e. serialising
 * the hottest write path in the product behind one row per workspace, and
 * paying that latency on every request forever to prevent a transient
 * off-by-a-few that self-corrects on the very next attempt. A small overshoot
 * is acceptable; a wrong count is not.
 *
 * Callers inside a transaction should pass their `tx` so the count is read in
 * the same transaction as the create.
 */

import type { Prisma } from '@prisma/client';
import { TenantLimitsSchema, type TenantLimits } from '@rekey.dev/shared-types';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { RekeyError } from './error.js';

/**
 * Anything that can run the two queries we need — the PrismaClient itself or
 * an interactive-transaction client.
 */
export type LimitsDb = Pick<Prisma.TransactionClient, 'tenant' | 'endUser' | 'application'>;

/**
 * Decode a stored `Tenant.limits` blob.
 *
 * Unset (null) → `{}` → unlimited. A blob that fails validation is also
 * treated as unlimited rather than throwing: the only writer is the
 * super-admin endpoint, which validates on the way in, so an invalid value
 * means someone hand-edited the database — and refusing every sign-up in the
 * workspace is a far worse failure mode than ignoring a limit nobody can
 * currently read.
 */
export function parseTenantLimits(value: Prisma.JsonValue | null | undefined): TenantLimits {
  if (value === null || value === undefined) return {};
  const parsed = TenantLimitsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

// ---------------------------------------------------------------------------
// Default ceilings for NEWLY created workspaces (DEFAULT_TENANT_LIMITS)
// ---------------------------------------------------------------------------
//
// `Tenant.limits` is only ever written after the fact, by the super-admin
// endpoint. So a workspace that nobody ever runs that endpoint against is
// unbounded — which is every workspace a plain operator sign-up produces. That
// is fine for a self-host and wrong for a deployment that wants a floor under
// every workspace it creates, so the floor is a deployment setting.
//
// It stays a setting, not a policy: this codebase does not know what a plan,
// price or tier is, and nothing here reads a subscription. The deployment
// supplies a number; the API applies it. Unset means NULL means unlimited,
// which is what every workspace gets today.

type DecodedDefault =
  | { ok: true; value: TenantLimits | null }
  | { ok: false; reason: string };

/**
 * Decode the raw env string. Unset/empty is a legitimate value (`null` =
 * unlimited), not an error; anything present must be JSON of the right shape.
 */
function decodeDefaultTenantLimits(raw: string | undefined): DecodedDefault {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'it is not valid JSON' };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, reason: 'it is not a JSON object' };
  }

  // Strict: a typo'd key ("maxProductionApp") must be loud. The whole point of
  // this variable is a ceiling the operator believes is in force.
  const parsed = TenantLimitsSchema.strict().safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Boot-time validation, called from app construction — same reasoning as
 * `assertAdminIpAllowlistValid`: a limits default that fails to parse would
 * otherwise be swallowed at runtime, and the operator would run a deployment
 * they believe caps every new workspace while it caps nothing. Refusing to
 * start is the smaller failure.
 */
export function assertDefaultTenantLimitsValid(): void {
  const raw = process.env.DEFAULT_TENANT_LIMITS ?? env.DEFAULT_TENANT_LIMITS;
  const decoded = decodeDefaultTenantLimits(raw);
  if (decoded.ok) return;
  throw new Error(
    `[CONFIG] DEFAULT_TENANT_LIMITS is not usable — ${decoded.reason}. ` +
      'It must be a JSON object matching TenantLimitsSchema, e.g. ' +
      '\'{"maxProductionApps":1}\' or \'{"maxActiveEndUsers":1000,"maxProductionApps":1}\'. ' +
      'Leave it unset for unlimited (the default).',
  );
}

/**
 * The configured default ceilings, or `null` for unlimited.
 *
 * Read live from `process.env` (falling back to the boot-validated value),
 * matching `adminIpAllowlist` and `operatorSignupMode` — capturing it at module
 * load makes the behaviour untestable in-process, because the module is
 * imported before a test can set the variable. An unparseable live override
 * falls back to the boot value, which validation has already proved good, so a
 * runtime typo cannot quietly widen a ceiling.
 */
export function defaultTenantLimits(): TenantLimits | null {
  const live = decodeDefaultTenantLimits(
    process.env.DEFAULT_TENANT_LIMITS ?? env.DEFAULT_TENANT_LIMITS,
  );
  if (live.ok) return live.value;
  const boot = decodeDefaultTenantLimits(env.DEFAULT_TENANT_LIMITS);
  return boot.ok ? boot.value : null;
}

/**
 * The `limits` fragment to spread into a `tenant.create` data object — THE
 * single place the default-vs-explicit decision is made.
 *
 * There are four `tenant.create` sites (see the docblock in
 * modules/tenants/tenants.service.ts) and all four spread this, so the default
 * cannot be applied on three paths and forgotten on the fourth. It returns the
 * fragment rather than a value so a call site that forgets it is a visibly
 * missing spread, not a subtly missing field.
 *
 * An explicitly-passed `limits` WINS over the deployment default, including an
 * explicit `{}` (which means "this workspace is unlimited, deliberately"). That
 * path is the super-admin one — provisioning a bespoke workspace is exactly
 * where an override belongs. Only `null`/`undefined` (nothing was asked for)
 * falls through to the default.
 */
export function resolveNewTenantLimits(
  explicit?: TenantLimits | null | undefined,
): { limits: Prisma.InputJsonValue } | Record<string, never> {
  const resolved = explicit ?? defaultTenantLimits();
  if (resolved === null) return {};
  return { limits: resolved as Prisma.InputJsonValue };
}

/** Non-erased end-users across every Application owned by this Tenant. */
export async function countActiveEndUsers(
  tenantId: string,
  db: LimitsDb = prisma,
): Promise<number> {
  // Counts every non-erased row across every Application the Tenant owns,
  // including DEVELOPMENT and STAGING apps. Keeping the rule "rows that
  // represent a person" makes the number match what an operator sees in the
  // panel, and means you can't duck the ceiling by moving signups into a
  // non-production Application.
  return db.endUser.count({
    where: { erasedAt: null, application: { tenantId } },
  });
}

/** Applications owned by this Tenant whose environment is PRODUCTION. */
export async function countProductionApps(
  tenantId: string,
  db: LimitsDb = prisma,
): Promise<number> {
  return db.application.count({
    where: { tenantId, environment: 'PRODUCTION' },
  });
}

/**
 * Throw `TENANT_QUOTA_EXCEEDED` when this workspace has no room for another
 * PRODUCTION Application. Call immediately before creating one; non-production
 * Applications must not route through here at all.
 *
 * No-op (and no query) when the workspace has no limit set, which is the
 * default everywhere.
 */
export async function assertProductionAppQuota(
  tenantId: string,
  db: LimitsDb = prisma,
): Promise<void> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { limits: true },
  });
  if (!tenant) return;

  const max = parseTenantLimits(tenant.limits).maxProductionApps;
  if (max === null || max === undefined) return;

  const current = await countProductionApps(tenantId, db);
  if (current < max) return;

  throw new RekeyError({
    statusCode: 403,
    code: 'TENANT_QUOTA_EXCEEDED',
    message:
      `This workspace has reached its limit of ${max} production application` +
      `${max === 1 ? '' : 's'} (currently ${current}). Applications in the staging and ` +
      'development environments are not counted and can still be created. Production ' +
      'applications that already exist are unaffected and keep serving traffic.',
    fix:
      'Create the application in the development or staging environment instead, ask a ' +
      'deployment super-admin to raise the workspace limit ' +
      '(PUT /api/v1/admin/tenants/:id/limits), or delete a production application the ' +
      'workspace no longer needs.',
  });
}

/**
 * Throw `TENANT_QUOTA_EXCEEDED` when this workspace has no room for another
 * end-user. Call immediately before any `endUser.create` — see the module
 * docblock for why every creation path must route through here.
 *
 * No-op (and one cheap indexed read) when the workspace has no limit set,
 * which is the default everywhere.
 */
export async function assertEndUserQuota(tenantId: string, db: LimitsDb = prisma): Promise<void> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { limits: true },
  });
  // Tenant gone mid-request: not our error to raise. The create will fail on
  // its own FK, with a message about the actual problem.
  if (!tenant) return;

  const max = parseTenantLimits(tenant.limits).maxActiveEndUsers;
  if (max === null || max === undefined) return;

  const current = await countActiveEndUsers(tenantId, db);
  if (current < max) return;

  throw new RekeyError({
    statusCode: 403,
    code: 'TENANT_QUOTA_EXCEEDED',
    message:
      `This workspace has reached its limit of ${max} end-user${max === 1 ? '' : 's'} ` +
      `(currently ${current}, counted across every application in the workspace). ` +
      'No new end-user can be created until there is room. End-users that already ' +
      'exist are unaffected and can still sign in.',
    fix:
      'Ask a deployment super-admin to raise the workspace limit ' +
      '(PUT /api/v1/admin/tenants/:id/limits), or free capacity by deleting or ' +
      'erasing end-users the workspace no longer needs.',
  });
}
