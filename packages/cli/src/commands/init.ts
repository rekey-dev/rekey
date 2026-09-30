/**
 * `rekey init`, bootstrap a fresh deployment.
 *
 * One-shot, non-interactive when given the required flags:
 *
 *   rekey init --tenant-name "Acme" --owner-email ops@acme.com \
 *                --app-name "Acme Prod" --app-slug acme-prod \
 *                --json
 *
 * Creates:
 *   1. A Tenant.
 *   2. A single-use owner invite for `--owner-email`, bound to that Tenant.
 *   3. An Application under that Tenant.
 *   4. The first API key for that Application.
 *
 * The super-admin routes write no membership, so without step 2 nobody could
 * reach the workspace: `--owner-email` alone is a label. Redeeming the invite
 * (panel link, or sign-up with it as `inviteKey`) makes that address the
 * workspace's OWNER instead of giving them a new, empty workspace. It is
 * minted before the Application so a failure there never costs the API key,
 * which is shown only once.
 *
 * The key's prefix follows the Application's `environment`. `init` does not
 * send one, so it bootstraps a DEVELOPMENT app and an `rp_test_` key, which is
 * the right default for a first run. Two ways out, neither of them the panel:
 * `rekey apps create --environment PRODUCTION` (the super-admin create route
 * has always accepted the field), or `POST /api/v1/tenant/applications/:id/promote`,
 * which raises an existing app to PRODUCTION once, one way.
 *
 * The raw API key and the invite token are shown ONCE, store them immediately.
 */

import type { Command } from 'commander';
import { ok, fail, readGlobalOpts, type OutputContext } from '../lib/output.js';
import { adminRequest } from '../lib/api.js';

interface InitOptions {
  tenantName?: string;
  ownerEmail?: string;
  appName?: string;
  appSlug?: string;
  apiKeyName?: string;
}

/**
 * The mint response. An API that predates workspace-bound invites drops
 * `tenantId`, `email` and `role` from the body and answers with an unbound
 * key, so none of the three can be assumed present.
 */
interface MintedOwnerInvite {
  invite: { id: string; tenantId?: string | null; email?: string | null; role?: string | null; expiresAt: string | null };
  rawToken: string;
  inviteUrl?: string | null;
}

type SignupMode = 'open' | 'invite' | 'closed';

/** What `init` reports about the owner invite, in both output modes. */
interface OwnerInviteSummary {
  email: string;
  role: string;
  expiresAt: string | null;
  token: string;
  /** The panel link, or null when the API has no `PANEL_URL` set. */
  url: string | null;
  /** The deployment's OPERATOR_SIGNUP_MODE, or null when it could not be read. */
  signupMode: SignupMode | null;
  /** What the owner does with the link, worded for `signupMode`. */
  nextStep: string;
}

/**
 * The deployment's sign-up mode, from the public probe. Null when it cannot
 * be read, and `init` then words its next step for every mode.
 */
async function fetchSignupMode(ctx: OutputContext): Promise<SignupMode | null> {
  if (!ctx.apiUrl) return null;
  try {
    const res = await fetch(`${ctx.apiUrl.replace(/\/$/, '')}/api/v1/tenant/auth/signup-mode`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { mode?: unknown } };
    const mode = body.data?.mode;
    return mode === 'open' || mode === 'invite' || mode === 'closed' ? mode : null;
  } catch {
    return null;
  }
}

function nextStep(email: string, role: string, mode: SignupMode | null): string {
  const existing = `If ${email} already has an operator account, they sign in as ${email} and accept.`;
  const signUp =
    `If not, they create an account from the link with that exact email; it joins this workspace ` +
    `instead of making a new one.`;
  const closed =
    'Sign-up is closed on this deployment, so nobody new can register: only an existing account can accept.';
  const lead = `Send the link to ${email}. It makes them ${role} of this workspace, once.`;
  if (mode === 'closed') return `${lead} ${closed} ${existing}`;
  if (mode === 'open' || mode === 'invite') {
    return `${lead} ${existing} ${signUp} Signing up without the link gives them a separate, empty workspace.`;
  }
  return (
    `${lead} ${existing} ${signUp} (If sign-up is closed on this deployment, only an existing account ` +
    `can accept.) Signing up without the link gives them a separate, empty workspace.`
  );
}

/**
 * Revoke a key the API minted unbound. Best effort: the failure being
 * reported matters more than this cleanup, which the fix text covers.
 */
async function revokeQuietly(ctx: OutputContext, inviteId: string): Promise<boolean> {
  if (!ctx.apiUrl || !ctx.adminKey) return false;
  try {
    const res = await fetch(
      `${ctx.apiUrl.replace(/\/$/, '')}/api/v1/admin/operator-invites/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${ctx.adminKey}` } },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Refuse an invite the API did not bind to `tenantId`. An older API ignores
 * the binding fields and mints a key that creates a NEW workspace, which is
 * the very failure the invite exists to prevent, so it is revoked, not shown.
 */
async function assertBound(
  ctx: OutputContext,
  minted: MintedOwnerInvite,
  tenantId: string,
): Promise<{ email: string; role: string }> {
  const { invite } = minted;
  if (invite.tenantId === tenantId && invite.email) {
    return { email: invite.email, role: invite.role ?? 'OWNER' };
  }
  const revoked = await revokeQuietly(ctx, invite.id);
  fail(ctx, {
    code: 'CLI_INVITE_UNBOUND',
    message:
      `The API minted an owner invite that is not bound to tenant ${tenantId}, so it would create a ` +
      `separate workspace instead of joining this one. This API predates workspace-bound invites.` +
      (revoked ? ' The key was revoked.' : ` Revoke it: DELETE /api/v1/admin/operator-invites/${invite.id}.`),
    fix:
      'Upgrade the Rekey API to 2.2.0 or later, then mint the owner invite with ' +
      `POST /api/v1/admin/operator-invites {"tenantId": "${tenantId}", "email": "<owner email>"}. ` +
      `Tenant ${tenantId} was created and has no Application yet.`,
  });
}

function renderOwnerInvite(invite: OwnerInviteSummary): void {
  const expiry = invite.expiresAt ? `expires ${invite.expiresAt}` : 'does not expire';
  process.stdout.write(`\nOWNER INVITE for ${invite.email} (single use, ${expiry}):\n`);
  if (invite.url) {
    process.stdout.write(`  ${invite.url}\n`);
  } else {
    process.stdout.write(`  <your panel URL>/accept-invite?token=${invite.token}\n`);
    process.stdout.write(`  (the API has no PANEL_URL set, so put your panel's address in front)\n`);
  }
  process.stdout.write(`\nNext: ${invite.nextStep}\n`);
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Bootstrap a fresh Rekey deployment: Tenant + owner invite + Application + first API key.',
    )
    .requiredOption('--tenant-name <name>', 'Display name for the new Tenant')
    .requiredOption(
      '--owner-email <email>',
      'Email of the Tenant owner. Receives a single-use invite that makes them OWNER.',
    )
    .requiredOption('--app-name <name>', 'Display name for the first Application')
    .requiredOption('--app-slug <slug>', 'URL-safe slug for the first Application')
    .option('--api-key-name <name>', 'Label for the first API key', 'cli')
    .action(async function (this: Command, opts: InitOptions) {
      const ctx = readGlobalOpts(this);
      if (!opts.tenantName || !opts.ownerEmail || !opts.appName || !opts.appSlug) {
        fail(ctx, {
          code: 'CLI_INIT_ARGS_MISSING',
          message: 'init requires --tenant-name, --owner-email, --app-name, --app-slug.',
          fix: 'Pass all four flags. See `rekey init --help`.',
        });
      }

      const tenant = await adminRequest<{ id: string; name: string; ownerEmail: string }>({
        ctx,
        method: 'POST',
        path: '/api/v1/admin/tenants',
        body: { name: opts.tenantName, ownerEmail: opts.ownerEmail },
      });

      const minted = await adminRequest<MintedOwnerInvite>({
        ctx,
        method: 'POST',
        path: '/api/v1/admin/operator-invites',
        body: {
          tenantId: tenant.id,
          email: opts.ownerEmail,
          role: 'OWNER',
          note: `rekey init owner of ${tenant.name}`.slice(0, 200),
        },
      });
      const bound = await assertBound(ctx, minted, tenant.id);
      const signupMode = await fetchSignupMode(ctx);
      const ownerInvite: OwnerInviteSummary = {
        ...bound,
        expiresAt: minted.invite.expiresAt,
        token: minted.rawToken,
        url: minted.inviteUrl ?? null,
        signupMode,
        nextStep: nextStep(bound.email, bound.role, signupMode),
      };

      const application = await adminRequest<{
        id: string;
        slug: string;
        publicKey: string;
      }>({
        ctx,
        method: 'POST',
        path: '/api/v1/admin/applications',
        body: { tenantId: tenant.id, name: opts.appName, slug: opts.appSlug },
      });

      const keyResp = await adminRequest<{
        apiKey: { id: string; keyPrefix: string };
        rawKey: string;
        warning: string;
      }>({
        ctx,
        method: 'POST',
        path: `/api/v1/admin/applications/${application.id}/api-keys`,
        body: { name: opts.apiKeyName ?? 'cli' },
      });

      ok(ctx, { tenant, ownerInvite, application, apiKey: keyResp }, (d) => {
        process.stdout.write(`✓ Tenant      ${d.tenant.id}  ${d.tenant.name}\n`);
        process.stdout.write(`✓ Owner       ${d.ownerInvite.email} (invited as ${d.ownerInvite.role})\n`);
        process.stdout.write(`✓ Application ${d.application.id}  ${d.application.slug}\n`);
        process.stdout.write(`✓ Public key  ${d.application.publicKey}\n`);
        process.stdout.write(`✓ API key     ${d.apiKey.apiKey.keyPrefix}…\n\n`);
        process.stdout.write(`SECRET KEY (shown once, save it now):\n`);
        process.stdout.write(`  ${d.apiKey.rawKey}\n`);
        renderOwnerInvite(d.ownerInvite);
      });
    });
}
