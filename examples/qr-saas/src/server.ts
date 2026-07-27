/**
 * QR SaaS HTTP server (Express). A real, runnable app:
 *
 *   POST /auth/sign-up            → Rekey auth.signUp
 *   POST /auth/sign-in            → Rekey auth.signIn
 *   GET  /auth/me                 → Rekey auth.getCurrentUser
 *   POST /auth/refresh            → Rekey auth.refresh
 *   POST /auth/sign-out           → Rekey auth.signOut
 *
 *   GET    /api/qrs               → list my QRs (scoped to active org if any)
 *   POST   /api/qrs               → create a dynamic QR (tier cap enforced)
 *   PATCH  /api/qrs/:id           → edit destination (the "dynamic" bit)
 *   DELETE /api/qrs/:id           → delete
 *   GET    /api/qrs/:id/qr.png    → the QR image encoding /q/:slug
 *   GET    /api/qrs/:id/analytics → scan analytics (Pro feature-flag gated)
 *
 *   GET  /api/billing/plans       → Rekey billing.getPlans
 *   GET  /api/billing/entitlements→ resolved entitlements (tier view)
 *   POST /api/billing/checkout    → Rekey billing.createCheckout (upgrade)
 *
 *   GET  /q/:slug                 → PUBLIC: record a qr_scans usage event,
 *                                   then 302 to the current destination.
 *
 * Auth model: the client sends the Rekey access token as a Bearer header;
 * an `x-organization-id` header opts a request into a team workspace. A browser
 * frontend would instead use @rekey.dev/react with the public key to manage the
 * session and attach the token automatically.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import QRCode from 'qrcode';
import { makeClient } from './relipay.js';
import { loadConfig } from './bootstrap.js';
import { qrService, QrError, type Subject } from './qr.js';
import { store } from './store.js';
import { INDEX_HTML } from './ui.js';
import { RekeyError } from '@rekey.dev/node';
import { ensureFreePlan } from './enroll.js';

const config = loadConfig();
const rekey = makeClient(config.secretKey);
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? `http://localhost:${PORT}`;

const app = express();
app.use(express.json());

// Minimal web UI (single page) so the app is usable in a browser, not just curl.
app.get('/', (_req, res) => {
  res.type('html').send(INDEX_HTML);
});

// The two config flags that change how the UI behaves: whether teams exist at
// all, and whether billing is per-user or per-team. The browser reads this to
// stop offering modes the Application isn't configured for (e.g. when
// billingSubject is 'org', billing + QRs MUST happen inside a team).
app.get(
  '/api/config',
  handler(async (_req, res) => {
    const me = await rekey.applications.me();
    res.json({
      organizationsEnabled: me.authConfig.organizationsEnabled,
      billingSubject: me.billingConfig.billingSubject,
    });
  }),
);

/** Resolve the Rekey subject from the request (Bearer token + optional org). */
async function authn(req: Request): Promise<Subject> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new QrError(401, 'UNAUTHENTICATED', 'Missing Bearer access token.');
  const user = await rekey.auth.getCurrentUser(token);
  // An explicit header wins; otherwise fall back to the token's active org claim.
  const orgHeader = req.header('x-organization-id') ?? null;
  return {
    accessToken: token,
    endUserId: user.id,
    organizationId: orgHeader ?? user.activeOrganizationId ?? null,
  };
}

/**
 * The Rekey billing subject for credits/usage: the active org's shared pool
 * when inside a team workspace, else the personal end-user. (Owner+beneficiary
 * billing — org QRs meter + draw down against the org, not the individual.)
 */
function creditSubject(subject: Subject): { endUserId: string } | { organizationId: string } {
  return subject.organizationId
    ? { organizationId: subject.organizationId }
    : { endUserId: subject.endUserId };
}

/** Start of the current calendar month (UTC) — matches Rekey's quota window. */
function monthStartUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Wrap an async handler, funneling RekeyError / QrError to JSON responses. */
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e) => {
      if (e instanceof QrError) {
        res.status(e.status).json({ error: { code: e.code, message: e.message, fix: e.fix } });
      } else if (e instanceof RekeyError) {
        res.status(e.statusCode ?? 500).json({ error: { code: e.code, message: e.message, fix: e.fix } });
      } else {
        next(e);
      }
    });
  };
}

// ---------- Auth (thin pass-through to Rekey) ----------

app.post(
  '/auth/sign-up',
  handler(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const result = await rekey.auth.signUp({ email, password });
    // Enroll the new user in the $0 Free plan so its USAGE quota (qr_scans) is
    // actually enforced. Rekey has no auto-assigned default plan — a freemium
    // tier must be a real ACTIVE subscription, even at amount 0, or
    // `includedQuotaFor` finds nothing and scans go uncapped (issue #63).
    // Best-effort + idempotent (see ensureFreePlan); never blocks sign-up.
    await ensureFreePlan(rekey, config, result.accessToken);
    res.json(result);
  }),
);

app.post(
  '/auth/sign-in',
  handler(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const result = await rekey.auth.signIn({ email, password });
    res.json(result);
  }),
);

app.get(
  '/auth/me',
  handler(async (req, res) => {
    const subject = await authn(req);
    const user = await rekey.auth.getCurrentUser(subject.accessToken);
    res.json(user);
  }),
);

app.post(
  '/auth/refresh',
  handler(async (req, res) => {
    const { refreshToken } = req.body as { refreshToken: string };
    res.json(await rekey.auth.refresh(refreshToken));
  }),
);

app.post(
  '/auth/sign-out',
  handler(async (req, res) => {
    const { refreshToken } = req.body as { refreshToken: string };
    res.json(await rekey.auth.signOut(refreshToken));
  }),
);

app.post(
  '/auth/magic-link',
  handler(async (req, res) => {
    const { email } = req.body as { email: string };
    // Enumeration-safe: same shape whether or not the email exists. With email
    // transport configured the link is mailed and magicLinkToken is null; in the
    // demo (no transport) the raw token comes back so the UI can show the link.
    // `{token}` is substituted with the raw token by Rekey when it builds the
    // email link; we land it back on this UI which auto-consumes it (see below).
    const result = await rekey.auth.requestMagicLink({
      email,
      signInUrl: `${PUBLIC_BASE}/?magic=1&token={token}`,
    });
    res.json(result);
  }),
);

app.post(
  '/auth/magic-link/verify',
  handler(async (req, res) => {
    const { token } = req.body as { token: string };
    res.json(await rekey.auth.verifyMagicLink({ token }));
  }),
);

// ---------- QR CRUD ----------

app.get(
  '/api/qrs',
  handler(async (req, res) => {
    const subject = await authn(req);
    const qrs = await qrService.list(rekey, subject);
    res.json({ qrs: qrs.map((q) => ({ ...q, shortUrl: `${PUBLIC_BASE}/q/${q.slug}` })) });
  }),
);

app.post(
  '/api/qrs',
  handler(async (req, res) => {
    const subject = await authn(req);
    const { destination, title, slug } = req.body as { destination: string; title?: string; slug?: string };
    const qr = await qrService.create(rekey, subject, { destination, title, slug });
    res.status(201).json({ ...qr, shortUrl: `${PUBLIC_BASE}/q/${qr.slug}` });
  }),
);

app.patch(
  '/api/qrs/:id',
  handler(async (req, res) => {
    const subject = await authn(req);
    const { destination } = req.body as { destination: string };
    const qr = await qrService.updateDestination(rekey, subject, req.params.id!, destination);
    res.json(qr);
  }),
);

app.delete(
  '/api/qrs/:id',
  handler(async (req, res) => {
    const subject = await authn(req);
    await qrService.remove(rekey, subject, req.params.id!);
    res.status(204).end();
  }),
);

app.get(
  '/api/qrs/:id/qr.png',
  handler(async (req, res) => {
    const subject = await authn(req);
    const qr = qrService.assertOwned(subject, req.params.id!);
    const png = await QRCode.toBuffer(`${PUBLIC_BASE}/q/${qr.slug}`, { width: 320, margin: 1 });
    res.type('png').send(png);
  }),
);

app.get(
  '/api/qrs/:id/analytics',
  handler(async (req, res) => {
    const subject = await authn(req);
    res.json(await qrService.analytics(rekey, subject, req.params.id!));
  }),
);

// ---------- Billing ----------

app.get(
  '/api/billing/plans',
  handler(async (_req, res) => {
    res.json({ plans: await rekey.billing.getPlans() });
  }),
);

app.get(
  '/api/billing/entitlements',
  handler(async (req, res) => {
    const subject = await authn(req);
    const ent = await rekey.billing.getEntitlements(
      subject.accessToken,
      subject.organizationId ? { organizationId: subject.organizationId } : undefined,
    );
    res.json(ent);
  }),
);

app.post(
  '/api/billing/checkout',
  handler(async (req, res) => {
    const subject = await authn(req);
    const { planSlug, organizationId } = req.body as { planSlug: string; organizationId?: string };
    const result = await rekey.billing.createCheckout(subject.accessToken, {
      planSlug,
      // Land back on the app UI so the user sees their upgraded plan.
      successUrl: `${PUBLIC_BASE}/?upgraded=1`,
      cancelUrl: `${PUBLIC_BASE}/?upgrade=cancel`,
      ...(organizationId ? { organizationId } : {}),
    });
    res.json(result);
  }),
);

// ---------- Credits (prepaid pack) + usage ----------

app.get(
  '/api/credits',
  handler(async (req, res) => {
    const subject = await authn(req);
    const [balance, ledger] = await Promise.all([
      rekey.credits.getBalance(creditSubject(subject)),
      rekey.credits.listLedger(creditSubject(subject), 10),
    ]);
    res.json({ balance: balance.balance, ledger });
  }),
);

app.post(
  '/api/credits/buy',
  handler(async (req, res) => {
    const subject = await authn(req);
    const result = await rekey.billing.createCheckout(subject.accessToken, {
      planSlug: 'qr_bulk_pack',
      successUrl: `${PUBLIC_BASE}/?bought=credits`,
      cancelUrl: `${PUBLIC_BASE}/?buy=cancel`,
      ...(subject.organizationId ? { organizationId: subject.organizationId } : {}),
    });
    res.json(result);
  }),
);

app.get(
  '/api/usage',
  handler(async (req, res) => {
    const subject = await authn(req);
    const agg = await rekey.usage.aggregate({
      meterSlug: 'qr_scans',
      from: monthStartUtc(),
      ...creditSubject(subject),
    });
    res.json({ meter: agg.meterSlug, total: agg.total, from: agg.from });
  }),
);

// ---------- Teams (Rekey organizations) ----------

app.get(
  '/api/orgs',
  handler(async (req, res) => {
    const subject = await authn(req);
    const orgs = await rekey.organizations.listMine(subject.accessToken);
    // The token's active-org claim tells the UI which workspace is current.
    res.json({ orgs, activeOrganizationId: subject.organizationId });
  }),
);

app.post(
  '/api/orgs',
  handler(async (req, res) => {
    const subject = await authn(req);
    const { name, slug } = req.body as { name: string; slug?: string };
    const cleanSlug =
      (slug || name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || `team-${Date.now()}`;
    const result = await rekey.organizations.create(subject.accessToken, { name, slug: cleanSlug });
    // A team is its own billing subject (org QRs + scans meter against the org
    // pool). Enroll the new org in the $0 Free plan too, so org scans are capped
    // the same way personal scans are. The creator is OWNER, so buying for the
    // org (owner+beneficiary) is allowed. Best-effort + idempotent.
    await ensureFreePlan(rekey, config, subject.accessToken, result.organization.id);
    res.status(201).json(result);
  }),
);

// Switching org mints a NEW token pair carrying the active-org claim. The client
// must replace its stored token so later reads default to the org's pooled view.
app.post(
  '/api/orgs/:id/switch',
  handler(async (req, res) => {
    const subject = await authn(req);
    res.json(await rekey.organizations.switch(subject.accessToken, req.params.id!));
  }),
);

app.post(
  '/api/orgs/clear-active',
  handler(async (req, res) => {
    const subject = await authn(req);
    res.json(await rekey.organizations.clearActive(subject.accessToken));
  }),
);

app.get(
  '/api/orgs/:id/members',
  handler(async (req, res) => {
    const subject = await authn(req);
    res.json({ members: await rekey.organizations.listMembers(subject.accessToken, req.params.id!) });
  }),
);

app.post(
  '/api/orgs/:id/invite',
  handler(async (req, res) => {
    const subject = await authn(req);
    const { email, role } = req.body as { email: string; role?: 'OWNER' | 'ADMIN' | 'MEMBER' };
    const result = await rekey.organizations.invite(subject.accessToken, req.params.id!, {
      email,
      role: role ?? 'MEMBER',
    });
    // The raw invite token is returned ONCE — a real app emails it; we surface it
    // so the demo user can copy the accept link.
    res.status(201).json(result);
  }),
);

// ---------- Account (active sessions) ----------

app.get(
  '/api/account/sessions',
  handler(async (req, res) => {
    const subject = await authn(req);
    res.json({ sessions: await rekey.auth.listSessions(subject.accessToken) });
  }),
);

app.delete(
  '/api/account/sessions/:id',
  handler(async (req, res) => {
    const subject = await authn(req);
    res.json(await rekey.auth.revokeSession(subject.accessToken, req.params.id!));
  }),
);

app.post(
  '/api/account/sign-out-everywhere',
  handler(async (req, res) => {
    const subject = await authn(req);
    res.json(await rekey.auth.signOutEverywhere(subject.accessToken));
  }),
);

// ---------- PUBLIC redirect + scan tracking ----------

app.get(
  '/q/:slug',
  handler(async (req, res) => {
    const qr = store.bySlug(req.params.slug!);
    if (!qr) {
      res.status(404).type('html').send('<h1>404</h1><p>Unknown QR code.</p>');
      return;
    }
    try {
      const { destination } = await qrService.recordScan(rekey, qr);
      res.redirect(302, destination);
    } catch (e) {
      // Over the monthly scan quota → Rekey returns 402. Degrade gracefully:
      // the destination still resolves but we surface a notice (a real product
      // might still redirect, or show an upgrade page — product choice).
      if (e instanceof RekeyError && e.statusCode === 402) {
        res
          .status(402)
          .type('html')
          .send('<h1>Scan limit reached</h1><p>This QR code owner has exceeded their monthly scan quota.</p>');
        return;
      }
      throw e;
    }
  }),
);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'qr-saas', rekeyApp: config.applicationSlug });
});

app.listen(PORT, () => {
  console.log(`QR SaaS listening on ${PUBLIC_BASE}`);
  console.log(`  Rekey app: ${config.applicationSlug} @ ${config.apiUrl}`);
  console.log(`  Public short links: ${PUBLIC_BASE}/q/:slug`);
});
