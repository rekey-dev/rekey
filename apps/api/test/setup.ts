/**
 * Per-file test setup.
 *
 * Truncates the domain tables before each test so individual cases stay
 * isolated. We use `TRUNCATE ... RESTART IDENTITY CASCADE` to also reset
 * sequences and follow FK chains — slightly heavier than per-table DELETE
 * but a lot less code than carefully ordering deletes.
 */

import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';

const DOMAIN_TABLES = [
  'idempotency_keys',
  'api_request_logs',
  'email_logs',
  'email_templates',
  'webhook_events',
  'coupon_redemptions',
  'coupons',
  'usage_records',
  'usage_meters',
  'license_activations',
  'licenses',
  'dunning_cases',
  'payments',
  'subscriptions',
  'plans',
  'mfa_credentials',
  'oauth_identities',
  'password_reset_tokens',
  'refresh_tokens',
  'webauthn_credentials',
  'magic_link_tokens',
  'impersonation_audits',
  'organization_invitations',
  'organization_memberships',
  'organizations',
  'api_keys',
  'end_users',
  'tenant_webauthn_credentials',
  'tenant_mfa_credentials',
  'tenant_invitations',
  'tenant_password_reset_tokens',
  'tenant_magic_link_tokens',
  'tenant_refresh_tokens',
  'application_grants',
  'operator_invites',
  'tenant_memberships',
  'tenant_users',
  'applications',
  'tenants',
];

beforeEach(async () => {
  // Quoted identifiers + RESTART IDENTITY + CASCADE.
  // Single statement so the truncate is atomic.
  const stmt = `TRUNCATE TABLE ${DOMAIN_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;
  // TRUNCATE needs an AccessExclusiveLock, which can deadlock (40P01) against a
  // still-in-flight best-effort INSERT from the previous test — e.g. the
  // fire-and-forget api_request_logs / security_events writers, whose writes
  // intentionally outlive the request. Retry a few times on deadlock; the
  // blocking write settles within milliseconds.
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(stmt);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2034' || /40P01|deadlock/i.test(String((err as Error).message))) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    }
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
