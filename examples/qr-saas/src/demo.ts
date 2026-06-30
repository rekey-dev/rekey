/**
 * End-to-end driver for the QR SaaS — exercises ReliPay as a real integrator:
 *
 *   A. Auth: sign-up, sign-in, getCurrentUser, refresh, sign-out.
 *   B. QR CRUD on the Free tier + the QR-count cap (402).
 *   C. Public scan tracking via usage.record + the monthly scan hard cap (402).
 *   D. Upgrade to Pro via checkout (stub) + the signed Stripe webhook path.
 *   E. Post-upgrade: higher caps, analytics feature flag unlocked.
 *   F. Credits: buy a bulk QR pack (CREDIT plan) + draw it down.
 *   G. Teams: create org, switch active org, org-pooled entitlements + usage.
 *
 * Run: `pnpm bootstrap && pnpm demo`. Idempotent against a fresh bootstrap.
 */

import { RelipayError } from '@relipay/node';
import { bootstrap, loadConfig, type QrSaasConfig } from './bootstrap.js';
import { makeClient } from './relipay.js';
import { qrService, resolveEntitlements, type Subject } from './qr.js';
import { store } from './store.js';
import { completeCheckoutViaWebhook } from './stripe-webhook.js';
import { activatePlan } from './enroll.js';
import {
  PLAN_PRO,
  PLAN_QR_PACK,
  FREE_MAX_QRS,
  FREE_SCANS_PER_MONTH,
  METER_QR_SCANS,
} from './constants.js';

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
async function section(title: string): Promise<void> {
  await sleep(PACE_MS);
  console.log(`\n=== ${title} ===`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * ReliPay enforces a global 100 req/min rate limit with no env override and no
 * per-route exemption (issue filed). The full demo makes well over 100 calls,
 * so we pace at section boundaries to avoid 429s. A real app wouldn't need this
 * for normal user traffic, but high-volume scan ingestion would hit it.
 */
const PACE_MS = Number(process.env.QR_PACE_MS ?? 700);

/** Capture a RelipayError (or QrError) thrown by an async fn. */
async function expectError(fn: () => Promise<unknown>): Promise<{ code?: string; status?: number } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof RelipayError) return { code: e.code, status: e.statusCode };
    const any = e as { code?: string; status?: number };
    return { code: any.code, status: any.status };
  }
}

async function main(): Promise<void> {
  store._reset();

  // Always re-bootstrap so the demo is self-contained + deterministic.
  const config: QrSaasConfig = process.env.QR_REUSE_CONFIG === '1' ? loadConfig() : await bootstrap();
  const relipay = makeClient(config.secretKey);

  // SDK smoke test.
  await section('SDK connectivity (relipay.applications.me)');
  const me = await relipay.applications.me();
  ok('applications.me() returns the app', me.slug === config.applicationSlug, `slug=${me.slug}`);
  ok('publicKey present on ApplicationDto', typeof me.publicKey === 'string' && me.publicKey.startsWith('rp_pub_'), me.publicKey);

  // ---------- A. AUTH ----------
  await section('A. Auth (sign-up, sign-in, getCurrentUser, refresh, sign-out)');
  const email = `alice+${Date.now()}@example.com`;
  const signUp = await relipay.auth.signUp({ email, password: 'correct-horse-battery-staple' });
  ok('auth.signUp returns access + refresh', !!signUp.accessToken && !!signUp.refreshToken, signUp.endUser.id);
  const endUserId = signUp.endUser.id;

  const signInOutcome = await relipay.auth.signIn({ email, password: 'correct-horse-battery-staple' });
  ok('auth.signIn (no MFA) returns a session', signInOutcome.mfaRequired === false && !!(signInOutcome as { accessToken: string }).accessToken);
  let accessToken = signInOutcome.mfaRequired === false ? (signInOutcome as { accessToken: string }).accessToken : signUp.accessToken;
  let refreshToken = signInOutcome.mfaRequired === false ? (signInOutcome as { refreshToken: string }).refreshToken : signUp.refreshToken;

  const current = await relipay.auth.getCurrentUser(accessToken);
  ok('auth.getCurrentUser resolves the user', current.id === endUserId, current.email);
  ok('getCurrentUser exposes activeOrganizationId', 'activeOrganizationId' in current, `oid=${current.activeOrganizationId}`);

  const refreshed = await relipay.auth.refresh(refreshToken);
  ok('auth.refresh rotates the token pair', !!refreshed.accessToken && refreshed.refreshToken !== refreshToken);
  accessToken = refreshed.accessToken;
  refreshToken = refreshed.refreshToken;

  // ---------- B. QR CRUD + count cap ----------
  await section('B. QR CRUD on Free tier + QR-count cap');
  const subject: Subject = { accessToken, endUserId, organizationId: null };

  // Subscribe the new user to the $0 Free plan so its USAGE quota is enforced.
  // (ReliPay has no auto-assigned default plan — a freemium tier is a real
  // ACTIVE subscription, even at amount 0.)
  await activatePlan(relipay, config, accessToken, 'free');
  const ent0 = await resolveEntitlements(relipay, subject);
  ok('Free plan resolves its entitlements', ent0.maxQrs === FREE_MAX_QRS && ent0.analytics === false, `maxQrs=${ent0.maxQrs}, analytics=${ent0.analytics}`);

  const created = [];
  for (let i = 0; i < FREE_MAX_QRS; i++) {
    created.push(await qrService.create(relipay, subject, { destination: `https://example.com/${i}`, title: `QR ${i}` }));
  }
  ok(`created ${FREE_MAX_QRS} QRs (the Free cap)`, created.length === FREE_MAX_QRS);

  const overCap = await expectError(() =>
    qrService.create(relipay, subject, { destination: 'https://example.com/over' }),
  );
  ok('creating past the cap is rejected (402)', overCap?.status === 402 && overCap.code === 'QR_LIMIT_REACHED', overCap?.code);

  const listed = await qrService.list(relipay, subject);
  ok('qrService.list returns owned QRs', listed.length === FREE_MAX_QRS);

  const target = created[0]!;
  const updated = await qrService.updateDestination(relipay, subject, target.id, 'https://example.com/edited');
  ok('edit destination (the "dynamic" part)', updated.destination === 'https://example.com/edited');

  // ---------- C. Public scan tracking + monthly scan hard cap ----------
  await section('C. Public scan tracking (usage.record) + monthly scan hard cap');
  // Record scans through the QR (org=null → end-user subject). Each call = 1
  // scan; pace lightly to stay under the 100 req/min global rate limit.
  const recordTo = FREE_SCANS_PER_MONTH; // fill the quota exactly
  for (let i = 0; i < recordTo; i++) {
    await qrService.recordScan(relipay, target);
    await sleep(120);
  }
  const aggUser = await relipay.usage.aggregate({ meterSlug: METER_QR_SCANS, endUserId });
  ok('usage.aggregate reflects recorded scans', aggUser.total === recordTo, `total=${aggUser.total}`);

  // The next scan exceeds the included quota → hard cap (402).
  const capHit = await expectError(() => qrService.recordScan(relipay, target));
  ok('monthly scan quota enforced as hard cap (402)', capHit?.status === 402 && capHit.code === 'USAGE_QUOTA_EXCEEDED', capHit?.code);

  // ---------- D. Upgrade to Pro via checkout + signed Stripe webhook ----------
  await section('D. Upgrade to Pro (checkout → signed Stripe webhook → ACTIVE)');
  const checkout = await relipay.billing.createCheckout(accessToken, {
    planSlug: PLAN_PRO,
    successUrl: 'https://qr.example/billing?ok=1',
    cancelUrl: 'https://qr.example/billing?cancel=1',
  });
  ok('billing.createCheckout returns a hosted URL + PENDING sub', !!checkout.url && checkout.subscription.status === 'PENDING', `provider=${checkout.provider}`);
  const checkoutSessionId = (checkout.subscription.metadata as { checkoutSessionId?: string }).checkoutSessionId!;
  ok('checkoutSessionId present on the PENDING subscription metadata', !!checkoutSessionId, checkoutSessionId);

  const webhookResult = await completeCheckoutViaWebhook({
    apiUrl: config.apiUrl,
    appSlug: config.applicationSlug,
    webhookSecret: config.stripeWebhookSecret,
    applicationId: config.applicationId,
    checkoutSessionId,
  });
  ok('signed webhook accepted (200 processed)', webhookResult.status === 200 && (webhookResult.body as { processed?: boolean }).processed === true, JSON.stringify(webhookResult.body));

  const sub = await relipay.billing.getSubscription(accessToken);
  ok('subscription is now ACTIVE', sub?.status === 'ACTIVE', `status=${sub?.status}`);

  // ---------- E. Post-upgrade entitlements ----------
  await section('E. Post-upgrade: Pro caps + analytics feature flag');
  const entPro = await resolveEntitlements(relipay, subject);
  ok('Pro raises the QR cap', entPro.maxQrs > FREE_MAX_QRS, `maxQrs=${entPro.maxQrs}`);
  ok('Pro unlocks analytics flag', entPro.analytics === true);

  // Now the QR we couldn't create on Free should succeed on Pro.
  const proQr = await qrService.create(relipay, subject, { destination: 'https://example.com/pro' });
  ok('can create beyond the Free cap on Pro', !!proQr.id);

  // Analytics is gated; should work now.
  const analytics = await qrService.analytics(relipay, subject, target.id);
  ok('analytics readable on Pro', typeof analytics.scans === 'number', `scans(30d)=${analytics.scans}`);

  // Scans should no longer hit the cap (Pro quota = 10k > the ~100 we recorded).
  const postUpgradeScan = await expectError(() => qrService.recordScan(relipay, proQr));
  ok('scans accepted again under the Pro quota', postUpgradeScan === null);

  // ---------- F. Credits (bulk QR pack) ----------
  await section('F. Credits — buy a CREDIT pack + draw it down');
  const packCheckout = await relipay.billing.createCheckout(accessToken, {
    planSlug: PLAN_QR_PACK,
    successUrl: 'https://qr.example/credits?ok=1',
    cancelUrl: 'https://qr.example/credits?cancel=1',
  });
  const packSessionId = (packCheckout.subscription.metadata as { checkoutSessionId?: string }).checkoutSessionId!;
  const packWebhook = await completeCheckoutViaWebhook({
    apiUrl: config.apiUrl,
    appSlug: config.applicationSlug,
    webhookSecret: config.stripeWebhookSecret,
    applicationId: config.applicationId,
    checkoutSessionId: packSessionId,
  });
  ok('CREDIT pack purchase webhook processed', packWebhook.status === 200);

  const balance = await relipay.credits.getBalance({ endUserId });
  ok('credit balance granted after purchase', balance.balance >= 500, `balance=${balance.balance}`);

  const consume = await relipay.credits.consume({ endUserId, amount: 10, description: 'bulk_generate', idempotencyKey: `demo-${Date.now()}` });
  ok('credits.consume draws down the balance', consume.applied === true && consume.balance === balance.balance - 10, `balance=${consume.balance}`);

  // ---------- G. Teams (orgs) ----------
  await section('G. Teams — create org, switch active org, org-pooled entitlements + usage');
  const orgSlug = `team-${Date.now().toString(36)}`;
  const orgCreate = await relipay.organizations.create(accessToken, { name: 'Acme Team', slug: orgSlug });
  ok('organizations.create makes the caller OWNER', orgCreate.membership.role === 'OWNER', orgCreate.organization.id);
  const orgId = orgCreate.organization.id;

  // Switch active org → fresh token carrying the `oid` claim.
  const switched = await relipay.organizations.switch(accessToken, orgId);
  ok('organizations.switch returns a new token pair', !!switched.accessToken && switched.accessToken !== accessToken);
  const orgAccessToken = switched.accessToken;
  const orgWhoami = await relipay.auth.getCurrentUser(orgAccessToken);
  ok('active org reflected in getCurrentUser (oid claim)', orgWhoami.activeOrganizationId === orgId, `oid=${orgWhoami.activeOrganizationId}`);

  // Buy Pro FOR the org (owner+beneficiary) so members share quota/analytics.
  const orgCheckout = await relipay.billing.createCheckout(orgAccessToken, {
    planSlug: PLAN_PRO,
    successUrl: 'https://qr.example/team?ok=1',
    cancelUrl: 'https://qr.example/team?cancel=1',
    organizationId: orgId,
  });
  const orgSessionId = (orgCheckout.subscription.metadata as { checkoutSessionId?: string }).checkoutSessionId!;
  const orgWebhook = await completeCheckoutViaWebhook({
    apiUrl: config.apiUrl,
    appSlug: config.applicationSlug,
    webhookSecret: config.stripeWebhookSecret,
    applicationId: config.applicationId,
    checkoutSessionId: orgSessionId,
  });
  ok('org Pro subscription activated via webhook', orgWebhook.status === 200);

  const orgEnt = await relipay.billing.getEntitlements(orgAccessToken, { organizationId: orgId });
  ok('org entitlements include analytics (pooled)', orgEnt.features.analytics === true, JSON.stringify(orgEnt.features));

  // Org-scoped subject: create a team QR + record an org-pooled scan.
  const orgSubject: Subject = { accessToken: orgAccessToken, endUserId, organizationId: orgId };
  const teamQr = await qrService.create(relipay, orgSubject, { destination: 'https://example.com/team', title: 'Team QR' });
  ok('team QR created in the org workspace', teamQr.organizationId === orgId);
  await qrService.recordScan(relipay, teamQr);
  const orgAgg = await relipay.usage.aggregate({ meterSlug: METER_QR_SCANS, organizationId: orgId });
  ok('org-pooled scan recorded against the org subject', orgAgg.total === 1, `orgTotal=${orgAgg.total}`);

  // Invite a teammate (raw token surfaced to the integrator's own email).
  const invite = await relipay.organizations.invite(orgAccessToken, orgId, { email: `bob+${Date.now()}@example.com`, role: 'MEMBER' });
  ok('organizations.invite returns a raw token to forward', !!invite.token, invite.invitation.id);

  // ---------- H. Sign-out ----------
  await section('H. Sign-out');
  const signedOut = await relipay.auth.signOut(refreshToken);
  ok('auth.signOut revokes the refresh token', signedOut.signedOut === true);
  const reuse = await expectError(() => relipay.auth.refresh(refreshToken));
  ok('revoked refresh token cannot be reused', reuse !== null, reuse?.code);

  // ---------- summary ----------
  console.log(`\n========================================`);
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nDemo crashed:', e);
  process.exit(1);
});
