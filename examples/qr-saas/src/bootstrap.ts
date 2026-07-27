/**
 * One-time Rekey provisioning for the QR SaaS — what a real integrator does
 * once in the panel before shipping. Idempotent-ish: re-running creates a new
 * tenant (unique email each run) so it always starts clean.
 *
 * Steps:
 *   1. Tenant operator sign-up (creates operator + workspace/Tenant).
 *   2. Create the Application (billing enabled).
 *   3. Enable organizations (teams) on the app's auth config.
 *   4. Set BYO Stripe credentials incl. a webhook signing secret — needed so
 *      the per-app Stripe webhook endpoint verifies our signed test events.
 *   5. Create the `qr_scans` usage meter.
 *   6. Create the Free plan (amount 0) + entitlements:
 *        FEATURE max_qr_codes=3, USAGE qr_scans included quota = 100/mo.
 *      Pro plan ($9/mo) + entitlements:
 *        FEATURE max_qr_codes=1000, FEATURE analytics=true,
 *        FEATURE custom_domain=true, USAGE qr_scans included quota = 10000/mo.
 *      QR bulk pack (CREDIT, $19) granting 500 credits.
 *   7. Mint a live secret key + read the public key.
 *
 * Persists everything to .data/rekey-config.json for the server + demo.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { TenantAdmin, RELIPAY_URL } from './relipay.js';
import {
  APP_SLUG,
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

const CONFIG_PATH = process.env.QR_CONFIG_PATH ?? join(process.cwd(), '.data', 'rekey-config.json');
/** BYO Stripe webhook secret — only used to sign offline test events locally. */
export const STRIPE_WEBHOOK_SECRET = 'whsec_qr_saas_local_test_secret';

export interface QrSaasConfig {
  apiUrl: string;
  tenantId: string;
  operatorEmail: string;
  operatorAccessToken: string;
  operatorRefreshToken: string;
  applicationId: string;
  applicationSlug: string;
  secretKey: string;
  publicKey: string;
  stripeWebhookSecret: string;
}

export function loadConfig(): QrSaasConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`No Rekey config at ${CONFIG_PATH}. Run \`pnpm bootstrap\` first.`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as QrSaasConfig;
}

function save(config: QrSaasConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export async function bootstrap(): Promise<QrSaasConfig> {
  const suffix = randomBytes(4).toString('hex');
  const operatorEmail = `founder+${suffix}@qrco.dev`;
  const log = (s: string) => console.log(`  • ${s}`);

  console.log('Bootstrapping Rekey for the QR SaaS...');

  // 1. Tenant operator sign-up.
  const session = await TenantAdmin.signUp(RELIPAY_URL, {
    email: operatorEmail,
    password: 'qr-saas-strong-pass-123',
    name: 'QR Founder',
    workspaceName: 'QR Co',
  });
  log(`tenant + operator created (${operatorEmail})`);
  const admin = new TenantAdmin(RELIPAY_URL, session.accessToken);

  // 2. Application (billing on).
  const slug = `${APP_SLUG}-${suffix}`;
  const app = await admin.createApplication({ name: 'QR SaaS', slug, enableBilling: true });
  log(`application created (${app.slug}, ${app.id})`);

  // 3. Enable organizations (teams).
  await admin.patchAuthConfig(app.id, { organizationsEnabled: true });
  log('organizations (teams) enabled');

  // Make sure billing is on (and bill the user by default; org billing is
  // explicit per-checkout via organizationId).
  await admin.patchBillingConfig(app.id, { enabled: true });

  // 4. BYO Stripe credentials incl. webhook signing secret.
  await admin.setStripeCredentials(app.id, {
    apiKey: 'sk_test_qr_saas_local',
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    enabled: true,
    mode: 'test',
  });
  log('Stripe BYO credentials set (stub provider + webhook secret)');

  // 5. Usage meter.
  await admin.createMeter(app.id, { slug: METER_QR_SCANS, name: 'QR Scans', unit: 'scan' });
  log(`usage meter "${METER_QR_SCANS}" created`);

  // 6a. Free plan + entitlements.
  await admin.createPlan(app.id, { slug: PLAN_FREE, name: 'Free', amount: 0, kind: 'SUBSCRIPTION' });
  await admin.upsertEntitlement(app.id, PLAN_FREE, {
    kind: 'FEATURE',
    key: FEAT_MAX_QRS,
    valueType: 'INT',
    value: String(FREE_MAX_QRS),
  });
  await admin.upsertEntitlement(app.id, PLAN_FREE, {
    kind: 'USAGE',
    key: METER_QR_SCANS,
    quantity: FREE_SCANS_PER_MONTH,
  });
  log(`Free plan: ${FREE_MAX_QRS} QRs, ${FREE_SCANS_PER_MONTH} scans/mo`);

  // 6b. Pro plan + entitlements.
  await admin.createPlan(app.id, {
    slug: PLAN_PRO,
    name: 'Pro',
    amount: 900,
    currency: 'USD',
    interval: 'MONTH',
    kind: 'SUBSCRIPTION',
  });
  await admin.upsertEntitlement(app.id, PLAN_PRO, {
    kind: 'FEATURE',
    key: FEAT_MAX_QRS,
    valueType: 'INT',
    value: String(PRO_MAX_QRS),
  });
  await admin.upsertEntitlement(app.id, PLAN_PRO, {
    kind: 'FEATURE',
    key: FEAT_ANALYTICS,
    valueType: 'BOOL',
    value: 'true',
  });
  await admin.upsertEntitlement(app.id, PLAN_PRO, {
    kind: 'FEATURE',
    key: FEAT_CUSTOM_DOMAIN,
    valueType: 'BOOL',
    value: 'true',
  });
  await admin.upsertEntitlement(app.id, PLAN_PRO, {
    kind: 'USAGE',
    key: METER_QR_SCANS,
    quantity: PRO_SCANS_PER_MONTH,
  });
  log(`Pro plan: ${PRO_MAX_QRS} QRs, ${PRO_SCANS_PER_MONTH} scans/mo, analytics + custom_domain`);

  // 6c. CREDIT pack for bulk QR generation.
  await admin.createPlan(app.id, {
    slug: PLAN_QR_PACK,
    name: 'Bulk QR Pack',
    amount: 1900,
    currency: 'USD',
    kind: 'CREDIT',
    creditsAmount: 500,
  });
  log(`CREDIT pack "${PLAN_QR_PACK}" created (500 credits / $19)`);

  // 7. Mint live secret key + read public key.
  const key = await admin.mintApiKey(app.id, {
    name: 'qr-saas-server',
    mode: 'live',
    scopes: [], // empty = full scope set for the app (auth + billing + usage)
  });
  const full = await admin.getApplication(app.id);
  log(`live secret key minted; public key = ${full.publicKey}`);

  const config: QrSaasConfig = {
    apiUrl: RELIPAY_URL,
    tenantId: session.activeTenantId,
    operatorEmail,
    operatorAccessToken: session.accessToken,
    operatorRefreshToken: session.refreshToken,
    applicationId: app.id,
    applicationSlug: app.slug,
    secretKey: key.rawKey,
    publicKey: full.publicKey,
    stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
  };
  save(config);
  console.log(`\nConfig written to ${CONFIG_PATH}`);
  return config;
}

// Run directly: `pnpm bootstrap`. Use pathToFileURL so a repo path containing
// spaces/special chars (which import.meta.url percent-encodes) still matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('\nBootstrap failed:', e);
      process.exit(1);
    });
}
