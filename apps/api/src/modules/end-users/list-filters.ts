/**
 * The operator end-user list's activity, audience and billing filters, the
 * ones the Users overview links into ("View all" on each table).
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CLIENT_PLATFORMS, CreatedViaSchema, SIGN_IN_VIAS } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { scopeDenied } from '../../lib/access-context.js';
import type { Scope } from '../../lib/operator-scopes.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function commaList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .string()
    .transform((s) => [...new Set(s.split(',').map((v) => v.trim()).filter(Boolean))])
    .pipe(z.array(item).min(1).max(max));
}

export const EndUserListFilterQuery = z.object({
  activeFrom: z.string().regex(DAY, 'Use YYYY-MM-DD.').optional(),
  activeTo: z.string().regex(DAY, 'Use YYYY-MM-DD.').optional(),
  inactiveForDays: z.coerce.number().int().min(1).max(3650).optional(),
  createdFrom: z.string().regex(DAY, 'Use YYYY-MM-DD.').optional(),
  createdTo: z.string().regex(DAY, 'Use YYYY-MM-DD.').optional(),
  minSignIns: z.coerce.number().int().min(0).max(1_000_000).optional(),
  platform: commaList(z.enum(CLIENT_PLATFORMS), CLIENT_PLATFORMS.length).optional(),
  country: commaList(
    z
      .string()
      .transform((c) => c.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, 'Use ISO 3166-1 alpha-2 codes.')),
    10,
  ).optional(),
  lastSignInVia: commaList(z.enum(SIGN_IN_VIAS), SIGN_IN_VIAS.length).optional(),
  createdVia: commaList(CreatedViaSchema, 10).optional(),
  onboarding: z.enum(['pending', 'completed', 'skipped']).optional(),
  mfa: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  plan: z.string().min(1).max(64).optional(),
  org: z.string().min(1).max(64).optional(),
});
export type EndUserListFilters = z.infer<typeof EndUserListFilterQuery>;

/** The JSON schema half, so Fastify documents the parameters without coercing them first. */
export const END_USER_LIST_FILTER_JSON_SCHEMA = {
  activeFrom: { type: 'string', description: 'Last active on or after this UTC day (YYYY-MM-DD).' },
  activeTo: { type: 'string', description: 'Last active on or before this UTC day (YYYY-MM-DD).' },
  inactiveForDays: { type: 'string', description: 'Not active in the last N UTC days, today included.' },
  createdFrom: { type: 'string', description: 'Created on or after this UTC day (YYYY-MM-DD).' },
  createdTo: { type: 'string', description: 'Created on or before this UTC day (YYYY-MM-DD).' },
  minSignIns: { type: 'string', description: 'At least this many sign-ins.' },
  platform: { type: 'string', description: 'Comma list of latest platforms.' },
  country: { type: 'string', description: 'Comma list of latest countries (ISO 3166-1 alpha-2).' },
  lastSignInVia: { type: 'string', description: 'Comma list of latest sign-in methods.' },
  createdVia: { type: 'string', description: 'Comma list: password, magic_link, oauth, oauth:<provider>, passkey, operator, import, billing, unknown.' },
  onboarding: { type: 'string', description: 'One of pending, completed, skipped.' },
  mfa: { type: 'string', description: 'true or false: has an enrolled second factor.' },
  plan: { type: 'string', description: 'Owns an ACTIVE, TRIALING or PAST_DUE subscription to this plan id. Needs billing:read.' },
  org: { type: 'string', description: 'Member of this organization id. Needs organizations:read.' },
} as const;

const utcDate = (day: string): Date => new Date(`${day}T00:00:00Z`);

function isRealDay(day: string): boolean {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

function listFilterInvalid(detail: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: `The end-user list filters are not valid: ${detail}`,
    fix: 'Use real YYYY-MM-DD days with each From on or before its To.',
  });
}

function planNotFound(planId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'PLAN_NOT_FOUND',
    message: `Plan "${planId}" not found in this Application.`,
    fix: 'List plans via GET /api/v1/tenant/applications/:id/plans and pass a plan id from there.',
  });
}

function organizationNotFound(orgId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'ORGANIZATION_NOT_FOUND',
    message: `Organization "${orgId}" not found in this Application.`,
    fix: 'List organizations via GET /api/v1/tenant/applications/:id/organizations and pass an id from there.',
  });
}

function createdViaWhere(values: string[]): Prisma.EndUserWhereInput {
  return {
    OR: values.map((v): Prisma.EndUserWhereInput => {
      if (v === 'unknown') return { createdVia: null };
      if (v === 'oauth') return { OR: [{ createdVia: 'oauth' }, { createdVia: { startsWith: 'oauth:' } }] };
      return { createdVia: v };
    }),
  };
}

/**
 * Refuse filters the caller may not use or that name another Application's
 * plan or organization, then build the `where` for the rest. Refused, never
 * ignored: an ignored filter returns an unfiltered list read as filtered.
 *
 * @example
 *   const where = await endUserListWhere(applicationId, filters, access.scopes);
 */
export async function endUserListWhere(
  applicationId: string,
  f: EndUserListFilters,
  scopes: ReadonlySet<Scope>,
  today: Date = new Date(),
): Promise<Prisma.EndUserWhereInput[]> {
  if (f.plan && !scopes.has('billing:read')) throw scopeDenied('billing:read');
  if (f.org && !scopes.has('organizations:read')) throw scopeDenied('organizations:read');
  if (f.activeFrom && f.activeTo && f.activeFrom > f.activeTo) throw listFilterInvalid('activeFrom is after activeTo.');
  if (f.createdFrom && f.createdTo && f.createdFrom > f.createdTo) throw listFilterInvalid('createdFrom is after createdTo.');
  for (const d of [f.activeFrom, f.activeTo, f.createdFrom, f.createdTo]) {
    if (d && !isRealDay(d)) throw listFilterInvalid(`${d} is not a day.`);
  }
  if (f.plan && !(await prisma.plan.findFirst({ where: { id: f.plan, applicationId }, select: { id: true } }))) {
    throw planNotFound(f.plan);
  }
  if (f.org && !(await prisma.organization.findFirst({ where: { id: f.org, applicationId }, select: { id: true } }))) {
    throw organizationNotFound(f.org);
  }

  const and: Prisma.EndUserWhereInput[] = [];
  if (f.activeFrom || f.activeTo) {
    and.push({
      lastActiveOn: {
        ...(f.activeFrom && { gte: utcDate(f.activeFrom) }),
        ...(f.activeTo && { lte: utcDate(f.activeTo) }),
      },
    });
  }
  if (f.inactiveForDays !== undefined) {
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const cutoff = new Date(todayUtc - (f.inactiveForDays - 1) * 86_400_000);
    and.push({ OR: [{ lastActiveOn: null }, { lastActiveOn: { lt: cutoff } }] });
  }
  if (f.createdFrom || f.createdTo) {
    and.push({
      createdAt: {
        ...(f.createdFrom && { gte: utcDate(f.createdFrom) }),
        ...(f.createdTo && { lt: new Date(utcDate(f.createdTo).getTime() + 86_400_000) }),
      },
    });
  }
  if (f.minSignIns !== undefined) and.push({ signInCount: { gte: f.minSignIns } });
  if (f.platform) and.push({ lastPlatform: { in: f.platform } });
  if (f.country) and.push({ lastCountry: { in: f.country } });
  if (f.lastSignInVia) and.push({ lastSignInVia: { in: f.lastSignInVia } });
  if (f.createdVia) and.push(createdViaWhere(f.createdVia));
  if (f.onboarding === 'completed') and.push({ onboardingCompletedAt: { not: null } });
  if (f.onboarding === 'skipped') and.push({ onboardingCompletedAt: null, onboardingSkippedAt: { not: null } });
  if (f.onboarding === 'pending') and.push({ onboardingCompletedAt: null, onboardingSkippedAt: null });
  if (f.mfa === true) and.push({ mfaCredential: { is: { enrolledAt: { not: null } } } });
  if (f.mfa === false) {
    and.push({ OR: [{ mfaCredential: { is: null } }, { mfaCredential: { is: { enrolledAt: null } } }] });
  }
  if (f.plan) {
    and.push({ subscriptions: { some: { planId: f.plan, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } } } });
  }
  if (f.org) and.push({ organizationMemberships: { some: { organizationId: f.org } } });
  return and;
}
