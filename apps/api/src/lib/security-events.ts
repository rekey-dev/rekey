/**
 * Security audit log writer.
 *
 * Appends security-relevant events (sign-ins, session kill-switch, API-key
 * lifecycle, …) to the `security_events` table for incident forensics.
 *
 * **Best-effort, never fatal.** A logging failure must not break the operation
 * being recorded, so `recordSecurityEvent` swallows its own errors. Call it
 * fire-and-forget: `void recordSecurityEvent({...})`.
 */

import type { FastifyRequest } from 'fastify';
import type { SecurityEventType } from '@rekey.dev/shared-types';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export type SecurityActorType = 'operator' | 'end_user' | 'system';

/**
 * Event types this API emits that `@rekey.dev/shared-types` does not label yet.
 *
 * The rule stays what it was, an emit site names a type from the shared union,
 * so the panel can label it, and this is the documented exception, not a way
 * around it. Both entries are the operator counterparts of `user.sign_in_failed`
 * / `user.locked_out`, added when operator sign-in failures were found to be
 * recorded nowhere at all. `humanizeSecurityEventType` degrades an unlabelled
 * key gracefully ("Sign in failed", "Locked out") rather than printing it raw,
 * so the panel is readable in the meantime.
 *
 * **Delete these two entries the moment shared-types carries them.** Nothing
 * breaks if you forget, the union just stops narrowing usefully.
 */
export type PendingSecurityEventType = 'operator.sign_in_failed' | 'operator.locked_out';

/** Every type an emit site in this API may name. */
export type EmittableSecurityEventType = SecurityEventType | PendingSecurityEventType;

export interface SecurityEventInput {
  /**
   * Dotted event name, e.g. "operator.sign_in", "app.sessions_rotated".
   *
   * Typed against the union in `@rekey.dev/shared-types`, which is also what
   * the operator panel labels events from. It used to be a bare `string`, and
   * a bare `string` on both sides is how the panel ended up rendering 44 of
   * the 54 types as raw keys: nothing connected an emit site to the list of
   * things anyone could display. Adding an event now means adding it there,
   * with a label, or this does not compile, the sole exception being
   * `PendingSecurityEventType`, which is enumerated above and is not a hole a
   * new event can slip through unnoticed.
   */
  type: EmittableSecurityEventType;
  actorType: SecurityActorType;
  actorId?: string | null;
  tenantId?: string | null;
  applicationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Pull the inbound IP + (truncated) user-agent off a request for the log. */
export function requestContext(req: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip || null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
  };
}

/**
 * The end-user an event is ABOUT, whoever performed it.
 *
 * An end-user's own events name them as the actor. Everything done TO them by
 * someone else, an operator blocking a device, the billing webhook creating
 * their account, names the subject in `metadata.endUserId` instead, with the
 * operator or the system as the actor. "Show me this person's history" needs
 * both, and the panel used to get it by pulling the application's last 200
 * events three times over (once per actor type) and matching either field in
 * memory: 600 rows fetched to render twenty, on every view of the end-user
 * screen.
 *
 * Deriving it here, at the only place an event is written, turns that into an
 * indexed equality. The explicit subject wins over the actor; the two have
 * never disagreed in recorded data (checked against every row on the bench
 * when this column was introduced), and if they ever did, the event is about
 * whoever it says it is about.
 */
export function subjectEndUserIdOf(
  input: Pick<SecurityEventInput, 'actorType' | 'actorId' | 'metadata'>,
): string | null {
  const explicit = input.metadata?.endUserId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (input.actorType === 'end_user' && input.actorId) return input.actorId;
  return null;
}

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    await prisma.securityEvent.create({ data: securityEventRow(input) });
  } catch {
    // Best-effort: an audit-log write must never break the action it records.
  }
}

/**
 * The durable variant: write the event through the caller's transaction, so
 * it commits with the action it records or neither does, and a failure fails
 * the action. For an action whose trail is part of its safety, such as a key
 * minting credits, where "applied but unaudited" must not be a possible state.
 */
export async function recordSecurityEventIn(
  tx: Pick<Prisma.TransactionClient, 'securityEvent'>,
  input: SecurityEventInput,
): Promise<void> {
  await tx.securityEvent.create({ data: securityEventRow(input) });
}

function securityEventRow(input: SecurityEventInput): Prisma.SecurityEventUncheckedCreateInput {
  return {
    type: input.type,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    subjectEndUserId: subjectEndUserIdOf(input),
    tenantId: input.tenantId ?? null,
    applicationId: input.applicationId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    metadata: (input.metadata ?? {}) as object,
  };
}

export interface SecurityEventQuery {
  tenantId: string;
  applicationId?: string | undefined;
  type?: string | undefined;
  actorType?: SecurityActorType | undefined;
  /**
   * Events ABOUT this end-user, from any actor, see `subjectEndUserIdOf`.
   * Not the same as `actorType=end_user` plus an actor id: that misses every
   * operator and system action taken on them.
   */
  endUserId?: string | undefined;
  /** Inclusive createdAt window. */
  from?: Date | undefined;
  to?: Date | undefined;
  /** Sort column (allowlisted at the route). Default createdAt. */
  sort?: 'createdAt' | 'type' | undefined;
  /** Sort direction. Default desc (newest first). */
  order?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /**
   * Hard cap on `limit`. Defaults to 200 (panel pages). The CSV export
   * passes a larger cap (it streams a bounded file, not a rendered table).
   */
  cap?: number | undefined;
}

/**
 * The Applications a workspace owns, for scoping a read.
 *
 * `SecurityEvent` carries `tenantId` and `applicationId` as bare scalars with
 * no FK relations, deliberately, the same reason `ApiRequestLog` does, so that
 * writing an audit row can never contend with or block the request it records.
 * That rules out a join, so the ids are fetched. One small query per read, on a
 * table an operator lists a page of at a time.
 */
async function tenantApplicationIds(tenantId: string): Promise<string[]> {
  const rows = await prisma.application.findMany({ where: { tenantId }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * The filter `listSecurityEvents` and `countSecurityEvents` share.
 *
 * One builder for both: a `total` computed over a different filter than the
 * rows is a pager that walks off the end of the log.
 *
 * ## Why an event is scoped two ways
 *
 * This used to be `tenantId: query.tenantId` alone, and a row written without a
 * `tenantId` was therefore durable, correct, and invisible: in the table, and in
 * no operator's log. Six emit sites had exactly that shape, the five device
 * events (`user.device_registered`, `user.device_limit_reached`, both
 * `*.device_released`, `end_user.device_blocked`, `end_user.device_unblocked`)
 * and `user.session_handoff_granted`, against 53 that pass it. So the whole
 * device audit trail was written and surfaced nowhere: blocking someone's device
 * recorded an event that appeared neither in the workspace Activity log nor on
 * the end-user it happened to.
 *
 * The obvious repair is to derive the tenant when the event is WRITTEN. That was
 * tried and reverted: it puts a read on the audit-write path, which is precisely
 * what the scalar-only schema exists to avoid, and it measurably reordered
 * detached webhook emission in `devices.test.ts` (~53% failure) by contending
 * for a connection with the `emitDetached` beside it.
 *
 * An event that names an Application already identifies its workspace, the
 * fact was never missing, only unjoined. So the scoping is done here, where a
 * query costs an operator's page load rather than somebody's sign-in, and it
 * fixes the rows already written: no backfill.
 *
 * `application: { tenantId }` is NOT expressible (no relation), hence the id
 * list. An empty list yields `in: []`, which matches nothing, correct for a
 * workspace with no Applications.
 */
async function securityEventWhere(query: SecurityEventQuery) {
  const ownedApplicationIds = await tenantApplicationIds(query.tenantId);
  return {
    // Either the row names this workspace, or it names an Application this
    // workspace owns. Both are the same claim; only one of them was recorded.
    OR: [{ tenantId: query.tenantId }, { applicationId: { in: ownedApplicationIds } }],
    ...(query.applicationId !== undefined && { applicationId: query.applicationId }),
    ...(query.type !== undefined && { type: query.type }),
    ...(query.actorType !== undefined && { actorType: query.actorType }),
    ...(query.endUserId !== undefined && { subjectEndUserId: query.endUserId }),
    ...((query.from || query.to) && {
      createdAt: {
        ...(query.from && { gte: query.from }),
        ...(query.to && { lte: query.to }),
      },
    }),
  };
}

/** Total events matching the same filters `listSecurityEvents` applies. */
export async function countSecurityEvents(query: SecurityEventQuery): Promise<number> {
  return prisma.securityEvent.count({ where: await securityEventWhere(query) });
}

/**
 * Who each event's actor is, by email, looked up when the log is READ.
 *
 * `actorId` alone is an opaque cuid: an operator reading "who did this to my
 * customer?" got `cmsa91v4c000nv5h5txnjvvry`, and the panel papered over it by
 * matching ids against the CURRENT member list, which lost every operator who
 * has since left the workspace (the people an audit trail most needs to name),
 * plus one request per end-user on the page.
 *
 * Resolved here, not stored on the row: the audit write stays a single insert
 * with no reads (the reason `SecurityEvent` has scalar ids and no relations,
 * see `securityEventWhere`), and an email is mutable, so the log shows who the
 * account is now rather than a copy that may be stale. Two batched reads per
 * page, whatever its size. An actor that no longer exists (a deleted operator,
 * an erased end-user row) resolves to `null` and the id still identifies it.
 *
 *   - `operator`: the operator account (`TenantUser`), whether or not they are
 *     still a member of this workspace.
 *   - `end_user`: the end-user, only within the Application the event names, so
 *     an id can never resolve across Applications.
 *   - `system` (and any type added later): `null`; there is no account to name.
 */
export async function withActorEmails<
  T extends { actorType: string; actorId: string | null; applicationId: string | null },
>(rows: T[]): Promise<Array<T & { actorEmail: string | null }>> {
  const operatorIds = new Set<string>();
  const endUserIds = new Set<string>();
  for (const r of rows) {
    if (!r.actorId) continue;
    if (r.actorType === 'operator') operatorIds.add(r.actorId);
    else if (r.actorType === 'end_user' && r.applicationId) endUserIds.add(r.actorId);
  }
  const [operators, endUsers] = await Promise.all([
    operatorIds.size > 0
      ? prisma.tenantUser.findMany({ where: { id: { in: [...operatorIds] } }, select: { id: true, email: true } })
      : Promise.resolve([]),
    endUserIds.size > 0
      ? prisma.endUser.findMany({
          where: { id: { in: [...endUserIds] } },
          select: { id: true, email: true, applicationId: true },
        })
      : Promise.resolve([]),
  ]);
  const operatorEmail = new Map(operators.map((o) => [o.id, o.email]));
  const endUser = new Map(endUsers.map((u) => [u.id, u]));
  return rows.map((r) => {
    let actorEmail: string | null = null;
    if (r.actorId && r.actorType === 'operator') actorEmail = operatorEmail.get(r.actorId) ?? null;
    if (r.actorId && r.actorType === 'end_user') {
      const u = endUser.get(r.actorId);
      actorEmail = u && u.applicationId === r.applicationId ? u.email : null;
    }
    return { ...r, actorEmail };
  });
}

/** List recent security events for a tenant (newest first, capped at `cap`, default 200). */
export async function listSecurityEvents(query: SecurityEventQuery): Promise<
  Array<{
    id: string;
    type: string;
    actorType: string;
    actorId: string | null;
    actorEmail: string | null;
    applicationId: string | null;
    ip: string | null;
    userAgent: string | null;
    metadata: unknown;
    createdAt: Date;
  }>
> {
  const rows = await prisma.securityEvent.findMany({
    where: await securityEventWhere(query),
    // Stable secondary order by id keeps pagination consistent on ties.
    orderBy: [
      query.sort === 'type'
        ? { type: query.order ?? 'desc' }
        : { createdAt: query.order ?? 'desc' },
      { id: 'desc' },
    ],
    take: Math.min(query.limit ?? 50, query.cap ?? 200),
    skip: query.offset ?? 0,
  });
  return withActorEmails(
    rows.map((r) => ({
      id: r.id,
      type: r.type,
      actorType: r.actorType,
      actorId: r.actorId,
      applicationId: r.applicationId,
      ip: r.ip,
      userAgent: r.userAgent,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
  );
}
