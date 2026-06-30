/**
 * Provision an EXISTING ReliPay Application with the QR product's billing
 * (usage meter + Free/Pro/credit plans + entitlements). Unlike `bootstrap.ts`
 * (which creates a brand-new tenant + app), this targets an app you already
 * created in the panel — e.g. wiring the demo to a deployed ReliPay.
 *
 * Plan/meter/entitlement creation is OPERATOR-gated (the tenant REST API), so
 * the Application secret key can't do it. Supply a short-lived operator access
 * token (`to_access` JWT) from your panel session:
 *
 *   RELIPAY_URL=https://api.relipay.dev \
 *   RELIPAY_APP_ID=<appId> \
 *   RELIPAY_OPERATOR_TOKEN=<to_access jwt> \
 *   pnpm tsx src/setup-deployed.ts
 *
 * Idempotent: re-running skips anything already created (entitlements are PUT).
 */

import { pathToFileURL } from 'node:url';
import { TenantAdmin, TenantApiError, RELIPAY_URL } from './relipay.js';
import {
  METER_QR_SCANS,
  PLAN_FREE,
  PLAN_PRO,
  PLAN_QR_PACK,
  FEAT_ANALYTICS,
  FEAT_CUSTOM_DOMAIN,
  FEAT_MAX_QRS,
  FREE_MAX_QRS,
  FREE_SCANS_PER_MONTH,
  PRO_MAX_QRS,
  PRO_SCANS_PER_MONTH,
} from './constants.js';

/** Run a create that may already exist; treat "already exists" as success. */
async function idempotent(label: string, fn: () => Promise<unknown>): Promise<void> {
  const log = (s: string) => console.log(`  • ${s}`);
  try {
    await fn();
    log(label);
  } catch (e) {
    if (e instanceof TenantApiError && /TAKEN|EXISTS|ALREADY/i.test(e.code)) {
      log(`${label} (already present — skipped)`);
      return;
    }
    throw e;
  }
}

export async function setupDeployed(appId: string, operatorToken: string): Promise<void> {
  const admin = new TenantAdmin(RELIPAY_URL, operatorToken);

  console.log(`Provisioning QR billing on app ${appId} @ ${RELIPAY_URL} ...`);

  await idempotent('organizations (teams) enabled', () =>
    admin.patchAuthConfig(appId, { organizationsEnabled: true }),
  );
  await idempotent('billing enabled', () => admin.patchBillingConfig(appId, { enabled: true }));

  await idempotent(`usage meter "${METER_QR_SCANS}"`, () =>
    admin.createMeter(appId, { slug: METER_QR_SCANS, name: 'QR Scans', unit: 'scan' }),
  );

  // Free plan ($0) — entitlements (PUT, always safe to repeat).
  await idempotent(`Free plan`, () =>
    admin.createPlan(appId, { slug: PLAN_FREE, name: 'Free', amount: 0, kind: 'SUBSCRIPTION' }),
  );
  await admin.upsertEntitlement(appId, PLAN_FREE, { kind: 'FEATURE', key: FEAT_MAX_QRS, valueType: 'INT', value: String(FREE_MAX_QRS) });
  await admin.upsertEntitlement(appId, PLAN_FREE, { kind: 'USAGE', key: METER_QR_SCANS, quantity: FREE_SCANS_PER_MONTH });
  console.log(`  • Free entitlements: ${FREE_MAX_QRS} QRs, ${FREE_SCANS_PER_MONTH} scans/mo`);

  // Pro plan ($9/mo).
  await idempotent('Pro plan', () =>
    admin.createPlan(appId, { slug: PLAN_PRO, name: 'Pro', amount: 900, currency: 'USD', interval: 'MONTH', kind: 'SUBSCRIPTION' }),
  );
  await admin.upsertEntitlement(appId, PLAN_PRO, { kind: 'FEATURE', key: FEAT_MAX_QRS, valueType: 'INT', value: String(PRO_MAX_QRS) });
  await admin.upsertEntitlement(appId, PLAN_PRO, { kind: 'FEATURE', key: FEAT_ANALYTICS, valueType: 'BOOL', value: 'true' });
  await admin.upsertEntitlement(appId, PLAN_PRO, { kind: 'FEATURE', key: FEAT_CUSTOM_DOMAIN, valueType: 'BOOL', value: 'true' });
  await admin.upsertEntitlement(appId, PLAN_PRO, { kind: 'USAGE', key: METER_QR_SCANS, quantity: PRO_SCANS_PER_MONTH });
  console.log(`  • Pro entitlements: ${PRO_MAX_QRS} QRs, ${PRO_SCANS_PER_MONTH} scans/mo, analytics + custom_domain`);

  // CREDIT pack ($19 → 500 credits).
  await idempotent(`CREDIT pack "${PLAN_QR_PACK}" (500 credits / $19)`, () =>
    admin.createPlan(appId, { slug: PLAN_QR_PACK, name: 'Bulk QR Pack', amount: 1900, currency: 'USD', kind: 'CREDIT', creditsAmount: 500 }),
  );

  console.log('\nDone. Plans live: free, pro_monthly, qr_bulk_pack.');
}

/**
 * Resolve an operator token: use RELIPAY_OPERATOR_TOKEN if given, else sign in
 * with RELIPAY_OPERATOR_EMAIL + RELIPAY_OPERATOR_PASSWORD (preferred — no
 * short-lived token to paste, and the password never leaves the machine you run
 * this on). Refuses MFA-gated operators (no second factor here).
 */
async function resolveOperatorToken(): Promise<string> {
  const token = process.env.RELIPAY_OPERATOR_TOKEN;
  if (token) return token;
  const email = process.env.RELIPAY_OPERATOR_EMAIL;
  const password = process.env.RELIPAY_OPERATOR_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Provide RELIPAY_OPERATOR_TOKEN, or RELIPAY_OPERATOR_EMAIL + RELIPAY_OPERATOR_PASSWORD.',
    );
  }
  const res = await fetch(`${RELIPAY_URL}/api/v1/tenant/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: { accessToken?: string; mfaRequired?: boolean };
    error?: { code: string; message: string };
  };
  if (!res.ok || json.success === false || !json.data?.accessToken) {
    if (json.data?.mfaRequired) throw new Error('Operator has MFA enabled — paste a token instead.');
    throw new Error(`Operator sign-in failed: ${json.error?.code ?? res.status} ${json.error?.message ?? ''}`);
  }
  return json.data.accessToken;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appId = process.env.RELIPAY_APP_ID;
  if (!appId) {
    console.error('Set RELIPAY_APP_ID (+ RELIPAY_URL). See file header.');
    process.exit(1);
  }
  resolveOperatorToken()
    .then((token) => setupDeployed(appId, token))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('\nSetup failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
