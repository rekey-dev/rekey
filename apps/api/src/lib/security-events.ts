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
import { prisma } from './prisma.js';

export type SecurityActorType = 'operator' | 'end_user' | 'system';

/**
 * Event types this API emits that `@rekey.dev/shared-types` does not label yet.
 *
 * The rule stays what it was — an emit site names a type from the shared union,
 * so the panel can label it — and this is the documented exception, not a way
 * around it. Both entries are the operator counterparts of `user.sign_in_failed`
 * / `user.locked_out`, added when operator sign-in failures were found to be
 * recorded nowhere at all. `humanizeSecurityEventType` degrades an unlabelled
 * key gracefully ("Sign in failed", "Locked out") rather than printing it raw,
 * so the panel is readable in the meantime.
 *
 * **Delete these two entries the moment shared-types carries them.** Nothing
 * breaks if you forget — the union just stops narrowing usefully.
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
   * with a label, or this does not compile — the sole exception being
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

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        type: input.type,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        tenantId: input.tenantId ?? null,
        applicationId: input.applicationId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  } catch {
    // Best-effort: an audit-log write must never break the action it records.
  }
}

export interface SecurityEventQuery {
  tenantId: string;
  applicationId?: string | undefined;
  type?: string | undefined;
  actorType?: SecurityActorType | undefined;
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
 * The filter `listSecurityEvents` and `countSecurityEvents` share.
 *
 * One builder for both: a `total` computed over a different filter than the
 * rows is a pager that walks off the end of the log.
 */
function securityEventWhere(query: SecurityEventQuery) {
  return {
    tenantId: query.tenantId,
    ...(query.applicationId !== undefined && { applicationId: query.applicationId }),
    ...(query.type !== undefined && { type: query.type }),
    ...(query.actorType !== undefined && { actorType: query.actorType }),
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
  return prisma.securityEvent.count({ where: securityEventWhere(query) });
}

/** List recent security events for a tenant (newest first, capped at `cap` — default 200). */
export async function listSecurityEvents(query: SecurityEventQuery): Promise<
  Array<{
    id: string;
    type: string;
    actorType: string;
    actorId: string | null;
    applicationId: string | null;
    ip: string | null;
    userAgent: string | null;
    metadata: unknown;
    createdAt: Date;
  }>
> {
  const rows = await prisma.securityEvent.findMany({
    where: securityEventWhere(query),
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
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actorType: r.actorType,
    actorId: r.actorId,
    applicationId: r.applicationId,
    ip: r.ip,
    userAgent: r.userAgent,
    metadata: r.metadata,
    createdAt: r.createdAt,
  }));
}
