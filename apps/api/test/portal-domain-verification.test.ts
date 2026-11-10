/**
 * Custom portal domains: the hostname rules on the PATCH that claims one, the
 * DNS TXT proof that verifies it, who may hold it, and the re-check that
 * withdraws a proof that no longer holds.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { isRegisteredAppOrigin, refreshCorsOrigins } from '../src/lib/cors-origins.js';
import {
  PORTAL_DOMAIN_LAPSE_AFTER_FAILURES,
  PORTAL_DOMAIN_RECHECK_INTERVAL_MS,
  __setTxtResolverForTests,
  normalisePortalDomain,
  portalDomainRecord,
  recheckPortalDomains,
} from '../src/modules/applications/portal-domain.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const DOMAIN = 'billing.acme.example';

/** TXT answers keyed by record name; a missing name answers ENODATA. */
let zone: Map<string, string[][]>;
let resolverError: string | null;

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('hostname rules', () => {
  it('lower-cases, drops one trailing dot and converts an IDN to punycode', () => {
    expect(normalisePortalDomain('  Billing.Acme.Example. ')).toBe('billing.acme.example');
    expect(normalisePortalDomain('bücher.example')).toBe('xn--bcher-kva.example');
  });

  it.each([
    ['a scheme', 'https://billing.acme.example'],
    ['a path', 'billing.acme.example/portal'],
    ['a port', 'billing.acme.example:8443'],
    ['a wildcard', '*.acme.example'],
    ['an IPv4 literal', '203.0.113.7'],
    ['an IPv6 literal', '[2001:db8::1]'],
    ['a single label', 'localhost'],
    ['credentials', 'user@billing.acme.example'],
    ['an empty label', 'billing..acme.example'],
    ['a label over 63 characters', `${'a'.repeat(64)}.example`],
    ['a leading hyphen', '-billing.acme.example'],
    ['an underscore', 'bill_ing.acme.example'],
  ])('refuses %s', (_shape, raw) => {
    expect(() => normalisePortalDomain(raw)).toThrow(expect.objectContaining({ code: 'PORTAL_DOMAIN_INVALID' }));
  });
});

describe('verification record', () => {
  it('changes with the domain and with the application', () => {
    const base = portalDomainRecord('app_a', DOMAIN);
    expect(base.name).toBe(`_rekey-portal.${DOMAIN}`);
    expect(portalDomainRecord('app_a', DOMAIN)).toEqual(base);
    expect(portalDomainRecord('app_a', 'other.acme.example').value).not.toBe(base.value);
    expect(portalDomainRecord('app_b', DOMAIN).value).not.toBe(base.value);
  });
});

describe('custom portal domain', () => {
  let app: FastifyInstance;
  let operator: string;

  beforeAll(async () => {
    __setTxtResolverForTests(async (name) => {
      if (resolverError) throw dnsError(resolverError);
      const answer = zone.get(name);
      if (!answer) throw dnsError('ENODATA');
      return answer;
    });
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    __setTxtResolverForTests(null);
    await app.close();
  });

  beforeEach(async () => {
    zone = new Map();
    resolverError = null;
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'domain-op@example.com', password: 'correct-horse-battery', workspaceName: 'Domain WS' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });
  afterEach(() => {
    resolverError = null;
  });

  async function createApp(slug: string): Promise<{ id: string; publicKey: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${operator}` },
      payload: { name: slug, slug, enableBilling: true },
    });
    const created = res.json().data as { id: string; publicKey: string };
    await prisma.application.update({ where: { id: created.id }, data: { hostedPortalEnabled: true } });
    return created;
  }

  const setDomain = (id: string, portalDomain: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${id}/portal`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { portalDomain },
    });

  const verify = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${id}/portal/domain/verify`,
      headers: { authorization: `Bearer ${operator}` },
    });

  function publish(id: string, domain = DOMAIN, chunks?: string[]): void {
    const record = portalDomainRecord(id, domain);
    zone.set(record.name, [chunks ?? [record.value]]);
  }

  async function verified(id: string): Promise<Date | null> {
    const row = await prisma.application.findUniqueOrThrow({ where: { id } });
    return row.portalDomainVerifiedAt;
  }

  describe('claiming a domain', () => {
    it('stores the normalised hostname and refuses a malformed one on the wire', async () => {
      const a = await createApp('claim-a');
      const ok = await setDomain(a.id, 'Billing.Acme.Example.');
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.portalDomain).toBe(DOMAIN);

      const bad = await setDomain(a.id, 'https://billing.acme.example/x');
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('PORTAL_DOMAIN_INVALID');
    });

    it("refuses the deployment's own portal and panel hosts", async () => {
      const a = await createApp('claim-own');
      for (const host of [new URL(process.env.PUBLIC_PORTAL_URL!).hostname, new URL(process.env.PANEL_URL!).hostname]) {
        const res = await setDomain(a.id, host);
        expect(res.json().error?.code, host).toBe('PORTAL_DOMAIN_RESERVED');
      }
    });

    it('exposes the record to publish on the application, and clears it with the domain', async () => {
      const a = await createApp('claim-record');
      await setDomain(a.id, DOMAIN);
      const read = () =>
        app
          .inject({ method: 'GET', url: `/api/v1/tenant/applications/${a.id}`, headers: { authorization: `Bearer ${operator}` } })
          .then((r) => r.json().data as { portalDomainTxtRecord: unknown });
      expect((await read()).portalDomainTxtRecord).toEqual(portalDomainRecord(a.id, DOMAIN));
      await setDomain(a.id, '');
      expect((await read()).portalDomainTxtRecord).toBeNull();
    });
  });

  describe('verifying', () => {
    it('verifies on an exact TXT match and records the event', async () => {
      const a = await createApp('verify-ok');
      await setDomain(a.id, DOMAIN);
      publish(a.id);
      const res = await verify(a.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.portalDomainVerifiedAt).toEqual(expect.any(String));
      expect(await verified(a.id)).not.toBeNull();
      const events = await prisma.securityEvent.findMany({ where: { applicationId: a.id, type: 'app.portal_domain_verified' } });
      expect(events).toHaveLength(1);
    });

    it('joins a record split into several strings before comparing', async () => {
      const a = await createApp('verify-chunks');
      await setDomain(a.id, DOMAIN);
      const { value } = portalDomainRecord(a.id, DOMAIN);
      publish(a.id, DOMAIN, [value.slice(0, 20), value.slice(20)]);
      expect((await verify(a.id)).statusCode).toBe(200);
    });

    it('does not match a value spread across two separate records', async () => {
      const a = await createApp('verify-split');
      await setDomain(a.id, DOMAIN);
      const record = portalDomainRecord(a.id, DOMAIN);
      zone.set(record.name, [[record.value.slice(0, 20)], [record.value.slice(20)]]);
      expect((await verify(a.id)).json().error.code).toBe('PORTAL_DOMAIN_NOT_VERIFIED');
    });

    it('fails on a missing record, naming the record expected', async () => {
      const a = await createApp('verify-missing');
      await setDomain(a.id, DOMAIN);
      const res = await verify(a.id);
      expect(res.statusCode).toBe(422);
      const record = portalDomainRecord(a.id, DOMAIN);
      expect(res.json().error.message).toContain(record.name);
      expect(res.json().error.message).toContain('There is no TXT record there');
      expect(res.json().error.fix).toContain(record.name);
      expect(res.json().error.fix).toContain(record.value);
      expect(await verified(a.id)).toBeNull();
      const failed = await prisma.securityEvent.count({
        where: { applicationId: a.id, type: 'app.portal_domain_verification_failed' },
      });
      expect(failed).toBe(1);
    });

    it("fails on another application's value, and bounds what it echoes", async () => {
      const a = await createApp('verify-wrong');
      await setDomain(a.id, DOMAIN);
      const record = portalDomainRecord(a.id, DOMAIN);
      const long = `v=spf1 ${'x'.repeat(500)}`;
      zone.set(record.name, [[portalDomainRecord('someone-else', DOMAIN).value], [long]]);
      const res = await verify(a.id);
      expect(res.json().error.code).toBe('PORTAL_DOMAIN_NOT_VERIFIED');
      expect(res.json().error.message).toContain(portalDomainRecord('someone-else', DOMAIN).value.slice(0, 60));
      expect(res.json().error.message).not.toContain(long);
      expect(res.json().error.message.length).toBeLessThanOrEqual(300);
    });

    it('reports a resolver failure as unavailable, not as a miss', async () => {
      const a = await createApp('verify-servfail');
      await setDomain(a.id, DOMAIN);
      resolverError = 'ESERVFAIL';
      const res = await verify(a.id);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('PORTAL_DOMAIN_DNS_UNAVAILABLE');
    });

    it('refuses when no domain is set', async () => {
      const a = await createApp('verify-none');
      expect((await verify(a.id)).json().error.code).toBe('PORTAL_DOMAIN_NOT_SET');
    });

    it('a new domain drops the old verification', async () => {
      const a = await createApp('verify-change');
      await setDomain(a.id, DOMAIN);
      publish(a.id);
      await verify(a.id);
      await setDomain(a.id, 'other.acme.example');
      expect(await verified(a.id)).toBeNull();
    });
  });

  describe('who holds a domain', () => {
    it('an unverified claim does not block another application, and the first to verify wins', async () => {
      const a = await createApp('hold-a');
      const b = await createApp('hold-b');
      await setDomain(a.id, DOMAIN);
      expect((await setDomain(b.id, DOMAIN)).statusCode).toBe(200);
      publish(b.id);
      expect((await verify(b.id)).statusCode).toBe(200);

      publish(a.id);
      expect((await verify(a.id)).json().error.code).toBe('PORTAL_DOMAIN_TAKEN');
      expect(await verified(a.id)).toBeNull();
    });

    it('a verified domain cannot be claimed by another application', async () => {
      const a = await createApp('taken-a');
      const b = await createApp('taken-b');
      await setDomain(a.id, DOMAIN);
      publish(a.id);
      await verify(a.id);
      const res = await setDomain(b.id, DOMAIN);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PORTAL_DOMAIN_TAKEN');
    });

    it('the database refuses a second verified holder even if the check is skipped', async () => {
      const a = await createApp('index-a');
      const b = await createApp('index-b');
      await prisma.application.update({ where: { id: a.id }, data: { portalDomain: DOMAIN, portalDomainVerifiedAt: new Date() } });
      await expect(
        prisma.application.update({ where: { id: b.id }, data: { portalDomain: DOMAIN, portalDomainVerifiedAt: new Date() } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('re-checking a verified domain', () => {
    const later = (n: number) => new Date(Date.now() + n * (PORTAL_DOMAIN_RECHECK_INTERVAL_MS + 1000));

    async function verifiedApp(slug: string): Promise<{ id: string; publicKey: string }> {
      const a = await createApp(slug);
      await setDomain(a.id, DOMAIN);
      publish(a.id);
      expect((await verify(a.id)).statusCode).toBe(200);
      return a;
    }

    it('keeps a domain whose record is still there', async () => {
      const a = await verifiedApp('recheck-ok');
      expect(await recheckPortalDomains(later(1))).toBe(0);
      expect(await verified(a.id)).not.toBeNull();
    });

    it('does not lapse on resolver failures, however many', async () => {
      const a = await verifiedApp('recheck-outage');
      resolverError = 'ETIMEOUT';
      for (let i = 1; i <= PORTAL_DOMAIN_LAPSE_AFTER_FAILURES + 1; i += 1) await recheckPortalDomains(later(i));
      expect(await verified(a.id)).not.toBeNull();
    });

    it('lapses only after consecutive misses, and a match resets the count', async () => {
      const a = await verifiedApp('recheck-lapse');
      const record = portalDomainRecord(a.id, DOMAIN);
      zone.delete(record.name);
      for (let i = 1; i < PORTAL_DOMAIN_LAPSE_AFTER_FAILURES; i += 1) await recheckPortalDomains(later(i));
      publish(a.id);
      await recheckPortalDomains(later(PORTAL_DOMAIN_LAPSE_AFTER_FAILURES));
      expect(await verified(a.id)).not.toBeNull();

      zone.delete(record.name);
      let lapsed = 0;
      for (let i = 1; i <= PORTAL_DOMAIN_LAPSE_AFTER_FAILURES; i += 1) {
        expect(await verified(a.id), `before miss ${i}`).not.toBeNull();
        lapsed += await recheckPortalDomains(later(PORTAL_DOMAIN_LAPSE_AFTER_FAILURES + i));
      }
      expect(lapsed).toBe(1);
      const row = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.portalDomainVerifiedAt).toBeNull();
      expect(row.portalDomainLapsedAt).not.toBeNull();
      expect(row.portalDomain).toBe(DOMAIN);
      expect(await prisma.securityEvent.count({ where: { applicationId: a.id, type: 'app.portal_domain_lapsed' } })).toBe(1);
    });

    it('a lapsed domain stops being honoured for CORS and emailed links', async () => {
      const a = await verifiedApp('recheck-honour');
      await prisma.application.update({ where: { id: a.id }, data: { corsOrigins: ['https://app.acme.example'] } });
      await refreshCorsOrigins();
      const origin = `https://${DOMAIN}`;
      const forgot = () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/forgot-password',
          headers: { authorization: `Bearer ${a.publicKey}`, origin },
          payload: { email: 'buyer@example.com', resetUrl: `${origin}/reset-password?token={token}` },
        });
      expect(isRegisteredAppOrigin(origin)).toBe(true);
      expect((await forgot()).statusCode).toBe(200);

      zone.clear();
      for (let i = 1; i <= PORTAL_DOMAIN_LAPSE_AFTER_FAILURES; i += 1) await recheckPortalDomains(later(i));

      expect(isRegisteredAppOrigin(origin)).toBe(false);
      const refused = await forgot();
      expect(refused.statusCode).toBe(403);
    });
  });
});
