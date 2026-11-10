/**
 * Organizations in the portal: switch the active one, manage members and
 * invitations by the tier the API returns, and accept an invitation link.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PLANS } from './fixtures/billing';

const state = {
  signedIn: true,
  activeOrganizationId: null as string | null,
  billingSubject: 'user' as 'user' | 'org',
  invitationCookie: undefined as string | undefined,
};
const cookieWrites: Array<{ name: string; value: string; path?: string }> = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === 'rekey_portal_access') return { name, value: 'at' };
      if (name === 'rekey_portal_invitation' && state.invitationCookie) return { name, value: state.invitationCookie };
      return undefined;
    },
    set: (name: string, value: string, opts?: { path?: string }) => cookieWrites.push({ name, value, path: opts?.path }),
  }),
  headers: async () => new Headers({ 'accept-language': 'en-US,en;q=0.9' }),
}));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({
    slug: 'acme',
    name: 'Acme',
    publishableKey: 'pk_test',
    billingEnabled: true,
    billingSubject: state.billingSubject,
    branding: {},
    auth: { password: true, magicLink: true, signup: true, devices: false },
  }),
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({}),
}));
vi.mock('@/lib/cookie-secure', () => ({ cookieSecure: async () => true }));
vi.mock('@/lib/two-factor', () => ({ redirectWhileTwoFactorOutstanding: async () => undefined }));
const revalidated: string[] = [];
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidated.push(path) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
const client = {
  getSubscription: vi.fn(async () => null),
  listSubscriptions: vi.fn(async () => ({ items: [] })),
  getPlans: vi.fn(async () => ({ items: [] })),
  listPayments: vi.fn(async () => ({ items: [] })),
  listOrganizations: vi.fn(async () => ({ items: ORGS })),
};
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getPortalUser: async () =>
    state.signedIn
      ? { accessToken: 'at', user: { id: 'eu_me', email: 'me@example.com', activeOrganizationId: state.activeOrganizationId } }
      : null,
  portalClientFor: async () => client,
}));

const { default: OrganizationPage } = await import('@/app/(portal)/[slug]/organization/page');
const { default: InvitationPage } = await import('@/app/(portal)/[slug]/invitation/page');
const { GET: invitationLink } = await import('@/app/(portal)/[slug]/invitation-link/route');
const { default: DashboardPage } = await import('@/app/(portal)/[slug]/(overview)/page');
const actions = await import('@/lib/organization-actions');
const { signOutAndReturnAction } = await import('@/lib/actions');
const { InvitationOutcome } = await import('@/components/invite-member-form');
const { afterSignInPath, signInReturnPage } = await import('@/lib/sign-in-return');
const { portalNav } = await import('@/lib/portal-nav');
const { middleware } = await import('@/middleware');

const ORG = (id: string, name: string, role: string, baseRole: string) => ({
  id,
  name,
  slug: id,
  metadata: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  role,
  baseRole,
});
let ORGS = [ORG('org_a', 'Alpha', 'OWNER', 'OWNER'), ORG('org_b', 'Beta', 'MEMBER', 'MEMBER')];
const ROLES = [
  { name: 'OWNER', baseRole: 'OWNER', isDefault: false, isBuiltIn: true, disabled: false },
  { name: 'ADMIN', baseRole: 'ADMIN', isDefault: false, isBuiltIn: true, disabled: false },
  { name: 'MEMBER', baseRole: 'MEMBER', isDefault: true, isBuiltIn: true, disabled: false },
  { name: 'editor', baseRole: 'MEMBER', isDefault: false, isBuiltIn: false, disabled: false },
  { name: 'retired', baseRole: 'MEMBER', isDefault: false, isBuiltIn: false, disabled: true },
];
const MEMBER = (endUserId: string, email: string, role: string, baseRole: string) => ({
  id: `m_${endUserId}`,
  organizationId: 'org_a',
  endUserId,
  email,
  role,
  baseRole,
  createdAt: '2026-02-01T00:00:00.000Z',
});
const MEMBERS = [
  MEMBER('eu_me', 'me@example.com', 'OWNER', 'OWNER'),
  MEMBER('eu_boss', 'boss@example.com', 'founder', 'OWNER'),
  MEMBER('eu_ed', 'ed@example.com', 'reviewer', 'MEMBER'),
];
const PENDING = [
  {
    id: 'inv_live',
    organizationId: 'org_a',
    email: 'waiting@example.com',
    role: 'editor',
    invitedBy: { endUserId: 'eu_boss', email: 'boss@example.com' },
    createdAt: '2026-02-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  },
  {
    id: 'inv_old',
    organizationId: 'org_a',
    email: 'late@example.com',
    role: 'MEMBER',
    invitedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  },
];
const PREVIEW = {
  organizationName: 'Alpha',
  applicationName: 'Acme',
  role: 'ADMIN',
  invitedEmail: 'm***@example.com',
  invitedBy: 'b***@example.com',
  expiresAt: '2026-03-01T00:00:00.000Z',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
const ok = (data: unknown) => json(200, { success: true, data });
const refusal = (status: number, code: string) => json(status, { success: false, error: { code } });

type Route = (init: RequestInit | undefined) => Response;
function api(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    'GET /api/v1/users/me/organizations': () => ok({ items: ORGS, page: { total: ORGS.length } }),
    'GET /api/v1/users/me/organizations/roles': () => ok(ROLES),
    'GET /api/v1/users/me/organizations/org_a/members': () => ok({ items: MEMBERS, page: { total: MEMBERS.length } }),
    'GET /api/v1/users/me/organizations/org_b/members': () => ok({ items: MEMBERS, page: { total: MEMBERS.length } }),
    'GET /api/v1/users/me/organizations/org_a/invitations': () => ok({ items: PENDING, page: { total: PENDING.length } }),
    'POST /api/v1/auth/organizations/invitation-preview': () => ok(PREVIEW),
    ...overrides,
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (route) return route(init);
    if (url.pathname.startsWith('/api/v1/billing') || url.pathname.startsWith('/api/v1/usage') || url.pathname.startsWith('/api/v1/credits') || url.pathname.startsWith('/api/v1/users/me/licenses')) {
      return refusal(404, 'NOT_HERE');
    }
    throw new Error(`unexpected call to ${init?.method} ${url.pathname}`);
  });
}

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await OrganizationPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}
async function renderInvitation(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await InvitationPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const m = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}
function memberRow(html: string, email: string): string {
  const row = html.split('<li').find((chunk) => chunk.includes(`>${email}`));
  if (!row) throw new Error(`no row for ${email}`);
  return row;
}
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(() => {
  state.signedIn = true;
  state.activeOrganizationId = null;
  state.billingSubject = 'user';
  state.invitationCookie = undefined;
  ORGS = [ORG('org_a', 'Alpha', 'OWNER', 'OWNER'), ORG('org_b', 'Beta', 'MEMBER', 'MEMBER')];
  cookieWrites.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('the organization page', () => {
  it('sends a signed-out visitor to sign in', async () => {
    state.signedIn = false;
    expect(await redirectOf(() => render())).toBe('/acme/login');
  });

  it('lists the organizations, marks the active one, and offers to switch to the others or back to personal', async () => {
    state.activeOrganizationId = 'org_a';
    api();
    const html = await render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(memberRow(html, 'Alpha')).toContain('>Active<');
    expect(memberRow(html, 'Beta')).toContain('Make active<span class="sr-only"> Beta</span>');
    expect(html).toContain('Use my personal account');
  });

  it('says what organizations are for when the customer has none', async () => {
    ORGS = [];
    api();
    const html = await render();
    expect(html).toContain('An organization lets a team share Acme and its plan.');
    expect(html).toContain('Create organization');
  });

  it('as an owner: invite, change role and remove for others, never for themselves, and no leave button', async () => {
    api();
    const html = await render();
    expect(html).toContain('Invite someone to Alpha');
    expect(memberRow(html, 'ed@example.com')).toContain('aria-label="Remove ed@example.com"');
    expect(memberRow(html, 'ed@example.com')).toContain('Role for ed@example.com');
    expect(memberRow(html, 'boss@example.com')).toContain('aria-label="Remove boss@example.com"');
    expect(memberRow(html, 'me@example.com')).not.toContain('Remove');
    expect(html).toContain('Owners cannot leave.');
    expect(html).not.toContain('>Leave organization<');
    expect(html).not.toContain('value="retired"');
  });

  it('as an admin: cannot touch an owner, and manages a member by the tier the API returns, not the role catalogue', async () => {
    ORGS = [ORG('org_a', 'Alpha', 'ADMIN', 'ADMIN')];
    api();
    const html = await render();
    expect(memberRow(html, 'boss@example.com')).not.toContain('Remove');
    expect(memberRow(html, 'ed@example.com')).toContain('aria-label="Remove ed@example.com"');
    expect(html).not.toContain('<option value="OWNER">');
    expect(html).toContain('<option value="editor">editor</option>');
    expect(html).toContain('>Leave organization<');
  });

  it('as a member, by tier and not by role name: no invite, change or remove, only leave', async () => {
    ORGS = [ORG('org_a', 'Alpha', 'Team lead', 'MEMBER')];
    api();
    const html = await render();
    expect(html).not.toContain('Invite someone');
    expect(html).not.toContain('aria-label="Remove');
    expect(html).not.toContain('Role for');
    expect(html).toContain('>Leave organization<');
  });

  it('lists pending invitations for an owner, with revoke behind a confirm and resend', async () => {
    api();
    const html = await render();
    expect(html).toContain('Pending invitations');
    const live = memberRow(html, 'waiting@example.com');
    expect(live).toContain('editor · Invited by boss@example.com · Expires');
    expect(live).toContain('aria-label="Revoke the invitation for waiting@example.com"');
    expect(live).toContain('<dialog');
    expect(live).toContain('Resend<span class="sr-only"> the invitation for waiting@example.com</span>');
    // Resend and Revoke share the row's button group, beside the address.
    expect(live).toMatch(/Resend<span class="sr-only">[^<]*<\/span><\/button><\/form><form[^>]*>.*aria-label="Revoke the invitation for waiting@example.com"/s);
    expect(memberRow(html, 'late@example.com')).toContain('Member · Expired');
  });

  it('never asks for pending invitations on behalf of a plain member', async () => {
    ORGS = [ORG('org_a', 'Alpha', 'MEMBER', 'MEMBER')];
    const spy = api();
    const html = await render();
    expect(html).not.toContain('Pending invitations');
    expect(spy.mock.calls.map((c) => new URL(String(c[0])).pathname)).not.toContain(
      '/api/v1/users/me/organizations/org_a/invitations',
    );
  });

  it("explains the API's refusals", async () => {
    api();
    expect(await render({ error: 'ORGANIZATION_LAST_OWNER' })).toContain(
      'An organization needs an owner. Make another member an owner first.',
    );
    expect(await render({ error: 'ORGANIZATION_ROLE_INSUFFICIENT' })).toContain(
      'Your role in this organization does not allow that.',
    );
  });
});

describe('switching the active organization', () => {
  it('re-mints the session into the cookies the way a refresh does, with no token in the URL', async () => {
    const spy = api({
      'POST /api/v1/users/me/organizations/org_b/switch': () =>
        ok({ accessToken: 'at_new', refreshToken: 'rt_new', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString() }),
    });
    const to = await redirectOf(() => actions.switchOrganizationAction('acme', 'org_b'));
    expect(to).toBe('/acme/organization?done=switched');
    expect(to).not.toContain('at_new');
    expect(cookieWrites).toEqual([
      { name: 'rekey_portal_access', value: 'at_new', path: '/acme' },
      { name: 'rekey_portal_refresh', value: 'rt_new', path: '/acme' },
    ]);
    expect(String(spy.mock.calls[0]![0])).toBe('https://api.example/api/v1/users/me/organizations/org_b/switch');
  });

  it('clears it back to the personal account', async () => {
    api({ 'POST /api/v1/users/me/organizations/clear-active-organization': () => ok({ accessToken: 'a2', refreshToken: 'r2' }) });
    expect(await redirectOf(() => actions.switchOrganizationAction('acme', null))).toBe('/acme/organization?done=personal');
  });

  it('keeps the cookies when the API refuses', async () => {
    api({ 'POST /api/v1/users/me/organizations/org_b/switch': () => refusal(403, 'ORGANIZATION_NOT_MEMBER') });
    expect(await redirectOf(() => actions.switchOrganizationAction('acme', 'org_b'))).toBe(
      '/acme/organization?error=ORGANIZATION_NOT_MEMBER',
    );
    expect(cookieWrites).toEqual([]);
  });
});

describe('managing members', () => {
  it('creates an organization with a slug made from its name', async () => {
    const spy = api({ 'POST /api/v1/users/me/organizations': () => json(201, { success: true, data: {} }) });
    expect(await redirectOf(() => actions.createOrganizationAction('acme', form({ name: 'Acme Labs, Inc.' })))).toBe(
      '/acme/organization?done=created',
    );
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ name: 'Acme Labs, Inc.', slug: 'acme-labs-inc' });
  });

  it('says plainly when the application does not allow creating one', async () => {
    api({ 'POST /api/v1/users/me/organizations': () => refusal(400, 'ORGANIZATIONS_NOT_ENABLED') });
    expect(await redirectOf(() => actions.createOrganizationAction('acme', form({ name: 'Team' })))).toBe(
      '/acme/organization?error=ORGANIZATIONS_NOT_ENABLED',
    );
    api();
    expect(await render({ error: 'ORGANIZATIONS_NOT_ENABLED' })).toContain('This app does not let you create organizations.');
  });

  it('invites by email, asks the API to mail a portal link, and hands the link back in the response, not a redirect', async () => {
    const spy = api({
      'POST /api/v1/users/me/organizations/org_a/invitations': () =>
        json(201, {
          success: true,
          data: {
            invitation: { id: 'inv_1', organizationId: 'org_a', email: 'new@example.com', role: 'editor', expiresAt: '', createdAt: '' },
            token: 'tok_secret',
            emailSent: true,
            warning: '',
          },
        }),
    });
    revalidated.length = 0;
    const state = await actions.inviteMemberAction('acme', 'org_a', { status: 'idle' }, form({ email: 'new@example.com', role: 'editor' }));
    expect(revalidated).toEqual(['/[slug]/organization']);
    expect(state).toMatchObject({
      status: 'invited',
      emailSent: true,
      link: 'https://portal.example/acme/invitation-link?token=tok_secret',
    });
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({
      email: 'new@example.com',
      role: 'editor',
      inviteUrl: 'https://portal.example/acme/invitation-link?token={token}',
    });
  });

  it('says the invitation was emailed, with Copy link as the secondary action, and shows the link only when no email went out', () => {
    const invitation = { id: 'inv_1', organizationId: 'org_a', email: 'new@example.com', role: 'ADMIN', expiresAt: '', createdAt: '' };
    const link = 'https://portal.example/acme/invitation-link?token=tok_secret';
    const emailed = renderToStaticMarkup(
      <InvitationOutcome slug="acme" organizationId="org_a" state={{ status: 'invited', invitation, link, emailSent: true }} />,
    );
    expect(emailed).toContain('We emailed an invitation to new@example.com to join as Admin.');
    expect(emailed).toContain('Copy link<span class="sr-only"> for new@example.com</span>');
    expect(emailed).not.toContain('tok_secret');
    const notEmailed = renderToStaticMarkup(
      <InvitationOutcome slug="acme" organizationId="org_a" state={{ status: 'invited', invitation, link, emailSent: false }} />,
    );
    expect(notEmailed).toContain('no email could be sent');
    expect(notEmailed).toContain(`value="${link}"`);
  });

  it('resends a pending invitation and hands back the fresh link in the response', async () => {
    api({
      'POST /api/v1/users/me/organizations/org_a/invitations/inv_live/resend': () =>
        json(201, {
          success: true,
          data: {
            invitation: { id: 'inv_new', organizationId: 'org_a', email: 'waiting@example.com', role: 'editor', expiresAt: '', createdAt: '' },
            token: 'tok_fresh',
            emailSent: true,
            warning: '',
          },
        }),
    });
    expect(await actions.resendInvitationAction('acme', 'org_a', 'inv_live', { status: 'idle' })).toMatchObject({
      status: 'invited',
      invitation: { id: 'inv_new' },
      link: 'https://portal.example/acme/invitation-link?token=tok_fresh',
    });
    api({ 'POST /api/v1/users/me/organizations/org_a/invitations/inv_live/resend': () => refusal(409, 'ORGANIZATION_INVITATION_NOT_PENDING') });
    expect(await actions.resendInvitationAction('acme', 'org_a', 'inv_live', { status: 'idle' })).toEqual({
      status: 'refused',
      message: 'That invitation was already accepted or revoked. Reload the page to see who is still invited.',
    });
  });

  it('explains an invitation the API refuses', async () => {
    api({ 'POST /api/v1/users/me/organizations/org_a/invitations': () => refusal(409, 'ORGANIZATION_ALREADY_MEMBER') });
    const state = await actions.inviteMemberAction('acme', 'org_a', { status: 'idle' }, form({ email: 'ed@example.com' }));
    expect(state).toEqual({ status: 'refused', message: 'That person is already a member.' });
  });

  it('changes a role, removes a member, revokes an invitation and leaves', async () => {
    const spy = api({
      'PATCH /api/v1/users/me/organizations/org_a/members/eu_ed': () => ok({}),
      'DELETE /api/v1/users/me/organizations/org_a/members/eu_ed': () => ok({ removed: true }),
      'POST /api/v1/users/me/organizations/org_a/invitations/inv_1/revoke': () => ok({ revoked: true }),
      'POST /api/v1/users/me/organizations/org_b/leave': () => ok({ removed: true }),
    });
    expect(await redirectOf(() => actions.changeMemberRoleAction('acme', 'org_a', 'eu_ed', form({ role: 'ADMIN' })))).toBe(
      '/acme/organization?done=role_changed',
    );
    expect(await redirectOf(() => actions.removeMemberAction('acme', 'org_a', 'eu_ed'))).toBe('/acme/organization?done=removed');
    expect(await redirectOf(() => actions.revokeInvitationAction('acme', 'org_a', 'inv_1'))).toBe(
      '/acme/organization?done=revoked',
    );
    expect(await redirectOf(() => actions.leaveOrganizationAction('acme', 'org_b'))).toBe('/acme/organization?done=left');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('passes the last-owner refusal on', async () => {
    api({ 'DELETE /api/v1/users/me/organizations/org_a/members/eu_boss': () => refusal(409, 'ORGANIZATION_LAST_OWNER') });
    expect(await redirectOf(() => actions.removeMemberAction('acme', 'org_a', 'eu_boss'))).toBe(
      '/acme/organization?error=ORGANIZATION_LAST_OWNER',
    );
  });
});

describe('accepting an invitation', () => {
  it('moves the link token into a cookie and lands on a token-free page', async () => {
    const res = await invitationLink(new NextRequest('https://portal.example/acme/invitation-link?token=tok_secret'), {
      params: Promise.resolve({ slug: 'acme' }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/acme/invitation');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('rekey_portal_invitation=tok_secret');
    expect(cookie).toContain('Path=/acme');
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('is reached as is with a stale session, so the token never goes round the refresh route', () => {
    const headers = { cookie: 'rekey_portal_refresh=rt', 'sec-fetch-dest': 'document' };
    const landing = new NextRequest('https://portal.example/acme/invitation-link?token=tok_secret', { headers });
    expect(middleware(landing).headers.get('location')).toBeNull();
  });

  it('asks a signed-out invitee to sign in and come back, saying what the invitation is for', async () => {
    state.signedIn = false;
    state.invitationCookie = 'tok_secret';
    const spy = api();
    const html = await renderInvitation();
    expect(html).toContain('b***@example.com invited you to join <strong>Alpha</strong> on Acme as Admin.');
    expect(html).toContain('Sign in with m***@example.com');
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ token: 'tok_secret' });
    expect(html).toContain('href="/acme/login?return=invitation"');
    expect(html).not.toContain('tok_secret');
    expect(afterSignInPath('acme', signInReturnPage('invitation'))).toBe('/acme/invitation');
  });

  it('says the page needs the link when there is no token', async () => {
    expect(await renderInvitation()).toContain('This page needs the invitation link you were sent.');
  });

  it('says plainly when the invitation can no longer be accepted, and offers no way to try', async () => {
    state.invitationCookie = 'tok_secret';
    api({ 'POST /api/v1/auth/organizations/invitation-preview': () => refusal(404, 'ORGANIZATION_INVITATION_UNAVAILABLE') });
    const html = await renderInvitation();
    expect(html).toContain('This invitation is no longer valid. Ask the person who invited you to send a new one.');
    expect(html).not.toContain('Accept invitation');
    expect(html).not.toContain('Sign in to accept');
  });

  it('still offers to accept when the invitation cannot be checked right now', async () => {
    state.invitationCookie = 'tok_secret';
    api({ 'POST /api/v1/auth/organizations/invitation-preview': () => refusal(503, 'SERVICE_UNAVAILABLE') });
    const html = await renderInvitation();
    expect(html).toContain('You were invited to join an organization on Acme.');
    expect(html).toContain('Accept invitation');
  });

  it('names the signed-in address once when it matches the invitation, and asks for the invited one when not', async () => {
    state.invitationCookie = 'tok_secret';
    api();
    let html = await renderInvitation();
    expect(html).toContain('You are signed in as <span class="break-all text-[var(--color-fg)]">me@example.com</span>.');
    expect(html).not.toContain('which must be');
    api({ 'POST /api/v1/auth/organizations/invitation-preview': () => ok({ ...PREVIEW, invitedEmail: 'r***@example.com' }) });
    html = await renderInvitation();
    expect(html).toContain('which must be the address it was sent to, r***@example.com.');
  });

  it('signs out from the invitation and comes back to it after signing in', async () => {
    expect(await redirectOf(() => signOutAndReturnAction('acme', 'invitation'))).toBe(
      '/acme/login?return=invitation',
    );
  });

  it('accepts with the cookie token, drops the cookie and goes to the organization page', async () => {
    state.invitationCookie = 'tok_secret';
    api();
    expect(await renderInvitation()).toContain('Accept invitation');
    const spy = api({ 'POST /api/v1/auth/organizations/accept-invitation': () => ok({ membership: {} }) });
    expect(await redirectOf(() => actions.acceptInvitationAction('acme'))).toBe('/acme/organization?done=joined');
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ token: 'tok_secret' });
    expect(cookieWrites).toContainEqual({ name: 'rekey_portal_invitation', value: '', path: '/acme' });
  });

  it('keeps the invitation when the wrong account is signed in, and says which to use', async () => {
    state.invitationCookie = 'tok_secret';
    api({ 'POST /api/v1/auth/organizations/accept-invitation': () => refusal(403, 'ORGANIZATION_INVITATION_EMAIL_MISMATCH') });
    const to = await redirectOf(() => actions.acceptInvitationAction('acme'));
    expect(to).toBe('/acme/invitation?error=ORGANIZATION_INVITATION_EMAIL_MISMATCH');
    expect(cookieWrites).toEqual([]);
    expect(await renderInvitation({ error: 'ORGANIZATION_INVITATION_EMAIL_MISMATCH' })).toContain(
      'This invitation was sent to m***@example.com, and you are signed in as me@example.com. Sign out, then sign in with m***@example.com.',
    );
  });

  it('drops an expired invitation', async () => {
    state.invitationCookie = 'tok_secret';
    api({ 'POST /api/v1/auth/organizations/accept-invitation': () => refusal(400, 'ORGANIZATION_INVITATION_EXPIRED') });
    expect(await redirectOf(() => actions.acceptInvitationAction('acme'))).toBe(
      '/acme/invitation?error=ORGANIZATION_INVITATION_EXPIRED',
    );
    expect(cookieWrites).toContainEqual({ name: 'rekey_portal_invitation', value: '', path: '/acme' });
  });
});

describe('organization billing on the dashboard', () => {
  async function dashboard(searchParams: Record<string, string> = {}): Promise<string> {
    const element = await DashboardPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) });
    return renderToStaticMarkup(element);
  }

  it('follows the active organization, read-only for a member', async () => {
    state.billingSubject = 'org';
    state.activeOrganizationId = 'org_b';
    client.listOrganizations.mockResolvedValue({ items: ORGS });
    client.getPlans.mockResolvedValueOnce({ items: [PLANS.team] } as never);
    api();
    const html = await dashboard();
    expect(html).toContain('Team: Beta');
    expect(html).toContain('only an owner or');
    expect(html).toContain('href="/acme/organization"');
    expect(html).not.toContain('href="/acme/plans/team"');
    expect(client.getSubscription).toHaveBeenLastCalledWith('at', { organizationId: 'org_b' });
  });

  it('turns the organization-required refusal into a link to the organization page', async () => {
    state.billingSubject = 'org';
    client.listOrganizations.mockResolvedValue({ items: [] });
    api();
    expect(await dashboard({ error: 'BILLING_ORGANIZATION_REQUIRED' })).toMatch(
      /<a href="\/acme\/organization"[^>]*>Choose or create an organization<\/a>/,
    );
  });

  it('shows the Organization section in the nav when the application bills or allows organizations, or one is active', () => {
    const config = (billingSubject: string, organizations: boolean) =>
      ({ billingSubject, auth: { devices: false, organizations } }) as never;
    const labels = (c: never, active: string | null) =>
      portalNav('acme', c, { user: { email: 'a@example.com', activeOrganizationId: active } }).map((i) => i.label);
    expect(labels(config('user', false), null)).not.toContain('Organization');
    expect(labels(config('user', true), null)).toContain('Organization');
    expect(labels(config('user', false), 'org_a')).toContain('Organization');
    expect(labels(config('org', false), null)).toContain('Organization');
  });
});
