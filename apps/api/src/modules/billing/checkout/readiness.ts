/**
 * Can the Rekey checkout page take a payment for this Application, in test
 * mode and in live mode? Eight checks, each with a fix that names a real
 * panel field, env var or action.
 *
 * The same checks serve two callers. The panel's preflight runs all eight for
 * every provider the geo router can pick, in the column of that provider's
 * credential mode. The per-checkout guard runs the critical ones (1 to 6) for
 * the one provider and plan a checkout resolved to, and a FAIL there falls
 * back to the provider's page or refuses, per the Application's setting.
 */

import type { Application, Plan } from '@prisma/client';
import type { CheckoutReadiness, CheckoutReadinessCheck } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { env } from '../../../config/env.js';
import { publicApiOrigin } from '../../../lib/public-api-origin.js';
import { registeredOrigins } from '../../../lib/app-url.js';
import { billingCredentialsService, hasWebhookConfigured, type BillingMode, type BillingProviderName } from '../credentials.service.js';
import { getModule } from '../providers/registry.js';
import { isOneTimePlan } from '../plan-kind.js';
import { planCheckoutReadiness } from '../../plans/plan-readiness.js';
import { checkReturnUrls } from '../checkout-return-url.js';
import { probePortal, type ProbeResult } from './portal-probe.js';

type Check = CheckoutReadinessCheck;
type Kind = 'recurring' | 'one_time';

const WEBHOOK_LOOKBACK_DAYS = 30;
const WEBHOOK_STALE_DAYS = 7;
/** The receipt note the webhook pipeline records for a mode-mismatch refusal. */
const MODE_MISMATCH_PREFIX = 'WEBHOOK_MODE_MISMATCH';
const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_REFRESH_MS = 5 * 60 * 1000;

const KILL_SWITCH_FIX =
  'The deployment has switched the Rekey checkout page off (CHECKOUT_EMBEDDED_ENABLED=false). Remove that setting from the API environment and restart it.';

function label(provider: string): string {
  return getModule(provider)?.display.label ?? provider;
}

function other(mode: BillingMode): BillingMode {
  return mode === 'live' ? 'test' : 'live';
}

function modeWord(mode: BillingMode): string {
  return mode === 'live' ? 'live' : 'sandbox';
}

function pass(id: Check['id'], provider: string | null, message: string): Check {
  return { id, provider, status: 'PASS', message, fix: null };
}

/** The stored probe result, or null when none has run. */
export function storedProbe(app: Pick<Application, 'checkoutReadiness'>): ProbeResult | null {
  const stored = (app.checkoutReadiness ?? null) as { probe?: ProbeResult } | null;
  return stored?.probe ?? null;
}

function apiUrl(): string {
  return publicApiOrigin() ?? env.API_URL ?? 'this deployment';
}

/** Check 1: the portal probe, as last run. */
export function portalCheck(probe: ProbeResult | null): Check {
  if (!env.CHECKOUT_EMBEDDED_ENABLED) {
    return { id: 'portal', provider: null, status: 'FAIL', message: 'The Rekey checkout page is switched off on this deployment.', fix: KILL_SWITCH_FIX };
  }
  if (probe === null) {
    return {
      id: 'portal',
      provider: null,
      status: 'FAIL',
      message: 'The portal has not been probed for this Application yet.',
      fix: 'Run the checks in Panel → Application → Billing → Checkout page.',
    };
  }
  return { id: 'portal', provider: null, status: probe.status, message: probe.message, fix: probe.fix };
}

/** Check 2: the provider can take this flow on the page; the mode agrees with the environment. */
export function providerCheck(
  provider: BillingProviderName,
  mode: BillingMode,
  kinds: ReadonlySet<Kind>,
  environment: Application['environment'],
  forPreflight: boolean,
): Check {
  const support = getModule(provider)?.capabilities.embeddedCheckout;
  const missing = [...kinds].filter((k) => (k === 'recurring' ? support?.recurring !== true : support?.oneTime !== true));
  if (missing.length > 0) {
    const what = missing.map((k) => (k === 'recurring' ? 'subscriptions' : 'one-time purchases')).join(' or ');
    return {
      id: 'provider',
      provider,
      status: 'FAIL',
      message: `The Rekey checkout page cannot take ${what} through ${label(provider)} yet.`,
      fix: `Keep the provider's page for this Application, or disable ${label(provider)} in Panel → Application → Billing → Billing providers so buyers are routed to a provider the page supports.`,
    };
  }
  if (forPreflight && mode === 'test' && environment === 'PRODUCTION') {
    return {
      id: 'provider',
      provider,
      status: 'WARN',
      message: `This PRODUCTION Application holds sandbox ${label(provider)} credentials. Buyers will see the test-mode banner and no money moves.`,
      fix: `Add live credentials in Panel → Application → Billing → Billing providers when you are ready to charge, and confirm the declared mode of the ${label(provider)} credentials is right.`,
    };
  }
  if (forPreflight && mode === 'live' && environment !== 'PRODUCTION') {
    return {
      id: 'provider',
      provider,
      status: 'WARN',
      message: `This ${environment} Application holds live ${label(provider)} credentials, so its checkouts move real money.`,
      fix: `Use sandbox credentials for a ${environment} Application, or confirm the declared mode of the ${label(provider)} credentials in Panel → Application → Billing → Billing providers.`,
    };
  }
  return pass('provider', provider, `${label(provider)} can take this Application's checkouts on the Rekey page.`);
}

/** Check 3: a webhook is registered and, in live mode, has delivered a verified event. */
export async function webhookCheck(
  applicationId: string,
  provider: BillingProviderName,
  mode: BillingMode,
  creds: unknown,
): Promise<Check> {
  const where = `Panel → Application → Billing → Billing providers → ${label(provider)}`;
  if (!hasWebhookConfigured(provider, creds)) {
    return {
      id: 'webhook',
      provider,
      status: 'FAIL',
      message: `No ${label(provider)} webhook is registered, and subscriptions activate only from the provider's webhook.`,
      fix: `Register the webhook in ${where} (Auto-configure, or paste its id in Edit).`,
    };
  }
  const lookbackDays =
    env.WEBHOOK_EVENT_RETENTION_DAYS > 0 ? Math.min(WEBHOOK_LOOKBACK_DAYS, env.WEBHOOK_EVENT_RETENTION_DAYS) : WEBHOOK_LOOKBACK_DAYS;
  // Only events verified with THIS mode's credentials, and only since they
  // were last saved: a sandbox delivery proves nothing about the live webhook,
  // and neither does an event verified with credentials since replaced.
  const credential = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId, provider } },
    select: { updatedAt: true },
  });
  const since = new Date(
    Math.max(Date.now() - lookbackDays * DAY_MS, credential?.updatedAt.getTime() ?? 0),
  );
  // A mode-mismatch refusal proves the webhook is wired to the other mode.
  // Matched by code, not by `processedAt`: an event that verified and then
  // failed to apply still proves delivery.
  const latest = await prisma.webhookEvent.findFirst({
    where: {
      applicationId,
      provider,
      mode,
      receivedAt: { gte: since },
      OR: [{ processingError: null }, { NOT: { processingError: { startsWith: MODE_MISMATCH_PREFIX } } }],
    },
    orderBy: { receivedAt: 'desc' },
    select: { receivedAt: true },
  });
  const firstPurchase =
    mode === 'live'
      ? `complete one checkout on the provider's page so an event arrives`
      : `complete one sandbox checkout (on the provider's page or on the Rekey page) so an event arrives`;
  if (latest === null) {
    return {
      id: 'webhook',
      provider,
      status: mode === 'live' ? 'FAIL' : 'WARN',
      message: `${label(provider)} has not delivered a webhook verified with these ${modeWord(mode)} credentials in the last ${lookbackDays} days, or since they were last saved.`,
      fix: `Check the webhook in ${where}, then ${firstPurchase}.`,
    };
  }
  if (latest.receivedAt.getTime() < Date.now() - WEBHOOK_STALE_DAYS * DAY_MS) {
    return {
      id: 'webhook',
      provider,
      status: 'WARN',
      message: `The last verified ${label(provider)} webhook arrived on ${latest.receivedAt.toISOString().slice(0, 10)}.`,
      fix: `Check that the webhook in ${where} is still active at ${label(provider)}.`,
    };
  }
  return pass('webhook', provider, `${label(provider)} delivered a verified webhook on ${latest.receivedAt.toISOString().slice(0, 10)}.`);
}

function registrationMode(plan: Plan, provider: BillingProviderName): { registered: boolean; mode: BillingMode | null } {
  const meta = (plan.metadata ?? {}) as Record<string, unknown>;
  const entry = meta[provider];
  if (entry === null || typeof entry !== 'object') return { registered: false, mode: null };
  const record = entry as Record<string, unknown>;
  const registered = typeof record.priceId === 'string' || typeof record.planId === 'string';
  const mode = record.mode === 'live' || record.mode === 'test' ? record.mode : null;
  return { registered, mode };
}

/** Check 4: every plan in scope is buyable through this provider, registered in this mode. */
export async function plansCheck(
  applicationId: string,
  provider: BillingProviderName,
  mode: BillingMode,
  plans: Plan[],
): Promise<Check> {
  const readiness = await planCheckoutReadiness(applicationId, plans);
  for (const plan of plans) {
    const blocker = readiness.get(plan.id)?.blockers.find((b) => b.provider === provider || b.provider === null);
    if (blocker) {
      return { id: 'plans', provider, status: 'FAIL', message: `Plan ${plan.slug}: ${blocker.message}`, fix: blocker.fix };
    }
    const registration = registrationMode(plan, provider);
    if (registration.registered && registration.mode === other(mode)) {
      return {
        id: 'plans',
        provider,
        status: 'FAIL',
        message: `Plan ${plan.slug} is registered at ${label(provider)} in ${modeWord(other(mode))}, and these credentials are ${modeWord(mode)}.`,
        fix: `A registered price cannot move between ${label(provider)} accounts. Create a replacement plan while the ${modeWord(mode)} credentials are set, and retire ${plan.slug}.`,
      };
    }
  }
  const legacy = plans.find((plan) => {
    const r = registrationMode(plan, provider);
    return r.registered && r.mode === null;
  });
  if (legacy) {
    return {
      id: 'plans',
      provider,
      status: 'WARN',
      message: `Plan ${legacy.slug} was registered at ${label(provider)} before Rekey recorded which mode a registration used.`,
      fix: `If checkouts for ${legacy.slug} fail at ${label(provider)}, create a replacement plan while the ${modeWord(mode)} credentials are set, and retire ${legacy.slug}.`,
    };
  }
  return pass('plans', provider, `Every plan in scope can be bought through ${label(provider)} in ${modeWord(mode)}.`);
}

/** Check 5 (preflight): the Application has an origin to send buyers back to. */
export function returnOriginsCheck(app: Pick<Application, 'authConfig'>): Check {
  if (registeredOrigins(app).size === 0) {
    return {
      id: 'return_urls',
      provider: null,
      status: 'FAIL',
      message: 'This Application has no registered origin, so the checkout page cannot send buyers back.',
      fix: "Set the Application URL (Panel → Application → Auth → Application URL) to your app's origin.",
    };
  }
  return pass('return_urls', null, 'The Application has a registered origin for return URLs.');
}

/** Check 5 (guard): this checkout's own return URLs are on registered origins. */
export function requestReturnUrlsCheck(
  app: Parameters<typeof checkReturnUrls>[0],
  urls: { successUrl: string; cancelUrl: string },
): Check {
  const warning = checkReturnUrls(app, urls)[0];
  if (warning) {
    return { id: 'return_urls', provider: null, status: 'FAIL', message: warning.message, fix: warning.fix };
  }
  return pass('return_urls', null, 'Both return URLs are on registered origins.');
}

/** Check 6: the public browser credential the provider's component needs. */
export function browserCredentialCheck(provider: BillingProviderName, creds: unknown): Check {
  const data = (creds ?? {}) as Record<string, unknown>;
  if (provider === 'paypal' && !(typeof data.clientId === 'string' && data.clientId.length > 0)) {
    return {
      id: 'browser_credential',
      provider,
      status: 'FAIL',
      message: 'The PayPal client ID is missing. It is a public value, sent only to the checkout page for this Application\'s sessions.',
      fix: 'Enter the Client ID in Panel → Application → Billing → Billing providers → PayPal → Edit.',
    };
  }
  return pass('browser_credential', provider, `${label(provider)} has the public credential its buttons need.`);
}

/** Check 7: the buyer sees the operator's name and logo. */
export function brandingCheck(app: Pick<Application, 'name' | 'portalBranding'>): Check {
  const branding = (app.portalBranding ?? {}) as Record<string, unknown>;
  const named = typeof branding.displayName === 'string' && branding.displayName.trim() !== '';
  const logo = typeof branding.logoUrl === 'string' && branding.logoUrl.trim() !== '';
  if (!named || !logo) {
    return {
      id: 'branding',
      provider: null,
      status: 'WARN',
      message: `Buyers will see "${named ? String(branding.displayName) : app.name}"${logo ? '' : ' and no logo'}.`,
      fix: 'Set a Display name and Logo URL in Panel → Application → Portal → Branding.',
    };
  }
  return pass('branding', null, 'The checkout page shows your display name and logo.');
}

/** Check 8: the portal receives CSP violation reports. */
export function cspReportsCheck(probe: ProbeResult | null): Check {
  if (probe === null || probe.status === 'FAIL' || !probe.cspReports) {
    return {
      id: 'csp_reports',
      provider: null,
      status: 'WARN',
      message: "The checkout page's CSP reports are not being received, so a blocked processor script would go unnoticed.",
      fix: 'Check that the portal service is running a version with the checkout page and can reach the API.',
    };
  }
  return pass('csp_reports', null, 'The portal receives CSP reports from the checkout page.');
}

function notApplicable(mode: BillingMode): Check[] {
  const elsewhere = mode === 'live' ? 'PRODUCTION' : 'DEVELOPMENT or STAGING';
  return [
    {
      id: 'provider',
      provider: null,
      status: 'N/A',
      message: `This Application holds no ${modeWord(mode)} credentials.`,
      fix: `Add ${modeWord(mode)} credentials for a provider in Panel → Application → Billing → Billing providers, or use your ${elsewhere} Application.`,
    },
  ];
}

async function paidPlans(applicationId: string): Promise<Plan[]> {
  return prisma.plan.findMany({ where: { applicationId, active: true, amount: { gt: 0 } }, orderBy: { slug: 'asc' } });
}

function kindsOf(plans: Plan[]): Set<Kind> {
  return new Set(plans.map((p) => (isOneTimePlan(p) ? 'one_time' : 'recurring')));
}

/**
 * Run all eight checks for both modes, probing the portal afresh, and store
 * the result on the Application.
 *
 * @example
 * const { test, live } = await runCheckoutReadiness(app);
 */
export async function runCheckoutReadiness(app: Application): Promise<CheckoutReadiness> {
  const probe = env.CHECKOUT_EMBEDDED_ENABLED ? await probePortal(app.slug, apiUrl()) : null;
  const providers = await billingCredentialsService.listCheckoutEnabled(app.id);
  const plans = await paidPlans(app.id);
  const kinds = kindsOf(plans);

  const columns: Record<BillingMode, Check[]> = { test: [], live: [] };
  for (const mode of ['test', 'live'] as const) {
    const inMode = providers.filter((p) => p.mode === mode);
    if (inMode.length === 0) {
      columns[mode] = notApplicable(mode);
      continue;
    }
    const checks: Check[] = [portalCheck(probe)];
    for (const { provider } of inMode) {
      const creds = await billingCredentialsService.loadDecrypted(app.id, provider).catch(() => null);
      checks.push(providerCheck(provider, mode, kinds, app.environment, true));
      checks.push(await webhookCheck(app.id, provider, mode, creds));
      checks.push(await plansCheck(app.id, provider, mode, plans));
      checks.push(browserCredentialCheck(provider, creds));
    }
    checks.push(returnOriginsCheck(app), brandingCheck(app), cspReportsCheck(probe));
    columns[mode] = checks;
  }

  const ranAt = new Date();
  const result: CheckoutReadiness = { test: columns.test, live: columns.live, ranAt: ranAt.toISOString() };
  await prisma.application.update({
    where: { id: app.id },
    data: { checkoutReadiness: { ...result, ...(probe !== null && { probe }) } as never, checkoutReadinessAt: ranAt },
  });
  return result;
}

const refreshing = new Set<string>();

/** Re-probe in the background when the stored result is older than five minutes. */
function refreshProbeIfStale(app: Pick<Application, 'id' | 'slug' | 'checkoutReadiness'>): void {
  const probe = storedProbe(app);
  const age = probe ? Date.now() - new Date(probe.at).getTime() : Infinity;
  if (age < PROBE_REFRESH_MS || refreshing.has(app.id)) return;
  refreshing.add(app.id);
  void probePortal(app.slug, apiUrl())
    .then(async (fresh) => {
      const current = await prisma.application.findUnique({ where: { id: app.id }, select: { checkoutReadiness: true } });
      const stored = (current?.checkoutReadiness ?? {}) as Record<string, unknown>;
      await prisma.application.update({ where: { id: app.id }, data: { checkoutReadiness: { ...stored, probe: fresh } as never } });
    })
    .catch(() => undefined)
    .finally(() => refreshing.delete(app.id));
}

/**
 * The per-checkout guard: the first critical check that fails for this one
 * checkout, or null when the Rekey page can serve it.
 *
 * Checks 1 to 6 only; branding and CSP reports never block a checkout.
 *
 * @example
 * const failed = await guardEmbeddedCheckout({ application, provider: 'paypal', mode: 'live', plan, successUrl, cancelUrl });
 * if (failed) fallBackOrRefuse(failed);
 */
export async function guardEmbeddedCheckout(args: {
  application: Application;
  provider: BillingProviderName;
  mode: BillingMode;
  plan: Plan;
  successUrl: string;
  cancelUrl: string;
}): Promise<Check | null> {
  const { application: app, provider, mode, plan } = args;
  const portal = portalCheck(storedProbe(app));
  if (portal.status === 'FAIL') return portal;
  refreshProbeIfStale(app);

  const kinds = new Set<Kind>([isOneTimePlan(plan) ? 'one_time' : 'recurring']);
  const support = providerCheck(provider, mode, kinds, app.environment, false);
  if (support.status === 'FAIL') return support;

  const creds = await billingCredentialsService.loadDecrypted(app.id, provider).catch(() => null);
  const credential = browserCredentialCheck(provider, creds);
  if (credential.status === 'FAIL') return credential;

  const webhook = await webhookCheck(app.id, provider, mode, creds);
  if (webhook.status === 'FAIL') return webhook;

  const plans = await plansCheck(app.id, provider, mode, [plan]);
  if (plans.status === 'FAIL') return plans;

  const urls = requestReturnUrlsCheck(app, { successUrl: args.successUrl, cancelUrl: args.cancelUrl });
  if (urls.status === 'FAIL') return urls;

  return null;
}

/** Test seam. */
export function __resetForTests(): void {
  refreshing.clear();
}
