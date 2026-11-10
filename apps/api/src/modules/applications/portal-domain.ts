/**
 * Custom portal domains: the hostname rules, the DNS ownership proof, and the
 * periodic re-check that withdraws a proof which no longer holds.
 *
 * A domain is honoured (CORS, emailed links, checkout returns, config by host)
 * only while `portalDomainVerifiedAt` is set. Several Applications may claim
 * one domain; at most one may hold it verified (partial unique index
 * `portal_domain_verified_key`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { Prisma, type Application } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { refreshCorsOrigins } from '../../lib/cors-origins.js';
import { recordSecurityEvent } from '../../lib/security-events.js';

export const PORTAL_DOMAIN_RECORD_PREFIX = '_rekey-portal';
const TOKEN_PREFIX = 'rekey-portal-verification=';

/** How often a verified domain's record is looked up again. */
export const PORTAL_DOMAIN_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Consecutive definite misses before verification is withdrawn. */
export const PORTAL_DOMAIN_LAPSE_AFTER_FAILURES = 3;
const RECHECK_BATCH = 100;

// Keeps the message inside the 300 characters the panel carries to its banner.
const MAX_SHOWN_RECORDS = 3;
const MAX_SHOWN_RECORD_LENGTH = 60;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_CHARS = /[\s/\\:@*?#[\]%]/;

/** The answer codes that mean "the zone says there is no such record". */
const DEFINITE_MISS_CODES = new Set(['ENODATA', 'ENOTFOUND']);

type TxtResolver = (name: string) => Promise<string[][]>;

const systemResolver = new Resolver({ timeout: 5_000, tries: 2 });
let resolveTxt: TxtResolver = (name) => systemResolver.resolveTxt(name);

/** Swap the DNS lookup. Test-only: the suite must not reach the network. */
export function __setTxtResolverForTests(resolver: TxtResolver | null): void {
  resolveTxt = resolver ?? ((name) => systemResolver.resolveTxt(name));
}

function invalidDomain(message: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'PORTAL_DOMAIN_INVALID',
    message,
    fix: 'Pass a bare hostname you control, like billing.yourapp.com: no scheme, path, port or wildcard.',
  });
}

/**
 * Normalise an operator-supplied portal domain to lower-case ASCII, or refuse it.
 * An internationalised name is converted to its punycode form, which is what
 * DNS and the browser's Host header carry.
 *
 * @example
 * normalisePortalDomain('Billing.Example.com.'); // 'billing.example.com'
 * normalisePortalDomain('bücher.example');        // 'xn--bcher-kva.example'
 */
export function normalisePortalDomain(raw: string): string {
  const trimmed = raw.trim();
  if (FORBIDDEN_CHARS.test(trimmed)) {
    throw invalidDomain(`"${trimmed.slice(0, 80)}" is not a bare hostname.`);
  }
  const ascii = domainToASCII(trimmed.replace(/\.$/, '')).toLowerCase();
  const labels = ascii.split('.');
  const valid =
    ascii.length > 0 &&
    ascii.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    !/^\d+$/.test(labels[labels.length - 1]!) &&
    isIP(ascii) === 0;
  if (!valid) throw invalidDomain(`"${trimmed.slice(0, 80)}" is not a valid hostname.`);
  return ascii;
}

/** Hosts this deployment itself answers on, which no Application may claim. */
function deploymentHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const url of [env.API_URL, env.PUBLIC_WEBHOOK_BASE_URL, env.PUBLIC_PORTAL_URL, env.PANEL_URL]) {
    if (url) hosts.add(new URL(url).hostname.toLowerCase());
  }
  return hosts;
}

/**
 * Check a normalised domain may be stored on `applicationId`: not one of this
 * deployment's own hosts, and not verified by another Application. A claim
 * held by another Application WITHOUT verification does not block it: whoever
 * proves DNS control first holds it.
 */
export async function assertPortalDomainClaimable(applicationId: string, domain: string): Promise<void> {
  if (deploymentHosts().has(domain)) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PORTAL_DOMAIN_RESERVED',
      message: `${domain} is a host this deployment itself serves, so it cannot be a portal domain.`,
      fix: 'Use a hostname under a domain you own, like billing.yourapp.com.',
    });
  }
  const holder = await prisma.application.findFirst({
    where: { portalDomain: domain, portalDomainVerifiedAt: { not: null }, id: { not: applicationId } },
    select: { id: true },
  });
  if (holder) throw domainTaken();
}

function domainTaken(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'PORTAL_DOMAIN_TAKEN',
    message: 'Another application has already verified that portal domain.',
    fix: 'Pick a different hostname.',
  });
}

/**
 * The TXT record that proves control of `domain` for `applicationId`. Derived
 * from JWT_SECRET, so nothing is stored, and a new domain or Application gets a
 * new value: a record published for one cannot verify another.
 *
 * @example
 * portalDomainRecord('app_1', 'billing.example.com');
 * // { name: '_rekey-portal.billing.example.com', value: 'rekey-portal-verification=…' }
 */
export function portalDomainRecord(applicationId: string, domain: string): { name: string; value: string } {
  const digest = createHmac('sha256', env.JWT_SECRET)
    .update(`portal-domain:${applicationId}:${domain}`)
    .digest('base64url');
  return { name: `${PORTAL_DOMAIN_RECORD_PREFIX}.${domain}`, value: `${TOKEN_PREFIX}${digest}` };
}

type Lookup =
  | { outcome: 'match' }
  | { outcome: 'miss'; found: string[] }
  | { outcome: 'unavailable'; code: string };

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A DNS answer is someone else's text: printable ASCII only, and bounded. */
function shown(record: string): string {
  const printable = record.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > MAX_SHOWN_RECORD_LENGTH ? `${printable.slice(0, MAX_SHOWN_RECORD_LENGTH)}…` : printable;
}

async function lookup(name: string, expected: string): Promise<Lookup> {
  let answers: string[][];
  try {
    answers = await resolveTxt(name);
  } catch (err) {
    const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'EUNKNOWN';
    return DEFINITE_MISS_CODES.has(code) ? { outcome: 'miss', found: [] } : { outcome: 'unavailable', code };
  }
  // A TXT record longer than 255 bytes arrives as several chunks of one string.
  const records = answers.map((chunks) => chunks.join(''));
  if (records.some((record) => sameText(record, expected))) return { outcome: 'match' };
  return { outcome: 'miss', found: records };
}

/** Who asked, for the security log. */
export interface PortalDomainActor {
  actorId: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Look up the application's TXT record and, on a match, mark its domain
 * verified. Throws with the record expected and what was found otherwise.
 *
 * @example
 * const app = await verifyPortalDomain(applicationId, { actorId, ip, userAgent });
 * app.portalDomainVerifiedAt; // Date
 */
export async function verifyPortalDomain(applicationId: string, actor: PortalDomainActor): Promise<Application> {
  const app = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
  const domain = app.portalDomain;
  if (!domain) {
    throw new RekeyError({
      statusCode: 409,
      code: 'PORTAL_DOMAIN_NOT_SET',
      message: 'This application has no custom portal domain to verify.',
      fix: 'Set one first: PATCH /api/v1/tenant/applications/:id/portal with { "portalDomain": "billing.yourapp.com" }.',
    });
  }
  await assertPortalDomainClaimable(applicationId, domain);

  const record = portalDomainRecord(applicationId, domain);
  const result = await lookup(record.name, record.value);
  const event = { actorType: 'operator' as const, tenantId: app.tenantId, applicationId, ...actor };

  if (result.outcome === 'unavailable') {
    throw new RekeyError({
      statusCode: 503,
      code: 'PORTAL_DOMAIN_DNS_UNAVAILABLE',
      message: `The DNS lookup for ${record.name} did not complete (${result.code}).`,
      fix: `Try again in a few minutes. If it keeps failing, check that the name servers for ${domain} answer queries.`,
    });
  }
  if (result.outcome === 'miss') {
    void recordSecurityEvent({
      ...event,
      type: 'app.portal_domain_verification_failed',
      metadata: { domain, recordsFound: result.found.length },
    });
    const found =
      result.found.length === 0
        ? 'There is no TXT record there'
        : `Found ${result.found.slice(0, MAX_SHOWN_RECORDS).map((r) => `"${shown(r)}"`).join(', ')}` +
          (result.found.length > MAX_SHOWN_RECORDS ? ` and ${result.found.length - MAX_SHOWN_RECORDS} more` : '');
    throw new RekeyError({
      statusCode: 422,
      code: 'PORTAL_DOMAIN_NOT_VERIFIED',
      message: `No TXT record at ${record.name} has the expected value. ${found}.`,
      fix:
        `Publish a TXT record named ${record.name} with the value ${record.value} at your DNS ` +
        'provider, wait for it to propagate, then verify again.',
    });
  }

  const now = new Date();
  let updated: Prisma.BatchPayload;
  try {
    // Scoped to the domain that was looked up: the operator may have changed
    // it while DNS answered, and the proof was for the old one.
    updated = await prisma.application.updateMany({
      where: { id: applicationId, portalDomain: domain },
      data: {
        portalDomainVerifiedAt: app.portalDomainVerifiedAt ?? now,
        portalDomainCheckedAt: now,
        portalDomainCheckFailures: 0,
        portalDomainLapsedAt: null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw domainTaken();
    throw err;
  }
  if (updated.count === 0) {
    throw new RekeyError({
      statusCode: 409,
      code: 'PORTAL_DOMAIN_CHANGED',
      message: 'The portal domain changed while it was being verified.',
      fix: 'Verify again: the TXT record to publish is the one shown for the current domain.',
    });
  }
  void recordSecurityEvent({ ...event, type: 'app.portal_domain_verified', metadata: { domain } });
  await refreshCorsOrigins();
  return prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
}

/**
 * Look up the record of each verified domain not checked within the interval.
 * A definite miss (no record, or no matching one) counts toward lapse; a
 * resolver failure does not, so a DNS outage never withdraws a domain.
 * Returns how many domains lapsed.
 *
 * @example
 * await recheckPortalDomains(); // 0 on a healthy deployment
 */
export async function recheckPortalDomains(now: Date = new Date()): Promise<number> {
  const due = await prisma.application.findMany({
    where: {
      portalDomain: { not: null },
      portalDomainVerifiedAt: { not: null },
      OR: [
        { portalDomainCheckedAt: null },
        { portalDomainCheckedAt: { lt: new Date(now.getTime() - PORTAL_DOMAIN_RECHECK_INTERVAL_MS) } },
      ],
    },
    select: { id: true, tenantId: true, portalDomain: true, portalDomainCheckFailures: true },
    orderBy: { portalDomainCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: RECHECK_BATCH,
  });

  let lapsed = 0;
  for (const app of due) {
    const domain = app.portalDomain!;
    const record = portalDomainRecord(app.id, domain);
    const result = await lookup(record.name, record.value);
    const where = { id: app.id, portalDomain: domain, portalDomainVerifiedAt: { not: null } };
    if (result.outcome !== 'miss') {
      await prisma.application.updateMany({
        where,
        data: {
          portalDomainCheckedAt: now,
          ...(result.outcome === 'match' && { portalDomainCheckFailures: 0 }),
        },
      });
      continue;
    }
    const failures = app.portalDomainCheckFailures + 1;
    if (failures < PORTAL_DOMAIN_LAPSE_AFTER_FAILURES) {
      await prisma.application.updateMany({
        where,
        data: { portalDomainCheckedAt: now, portalDomainCheckFailures: failures },
      });
      continue;
    }
    const withdrawn = await prisma.application.updateMany({
      where,
      data: {
        portalDomainVerifiedAt: null,
        portalDomainLapsedAt: now,
        portalDomainCheckedAt: now,
        portalDomainCheckFailures: 0,
      },
    });
    if (withdrawn.count === 0) continue;
    lapsed += 1;
    void recordSecurityEvent({
      type: 'app.portal_domain_lapsed',
      actorType: 'system',
      tenantId: app.tenantId,
      applicationId: app.id,
      metadata: { domain, consecutiveFailures: failures },
    });
  }
  if (lapsed > 0) await refreshCorsOrigins();
  return lapsed;
}
