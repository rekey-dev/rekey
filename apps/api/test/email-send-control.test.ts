/**
 * Turning email off, and what that must NOT do.
 *
 * `dispatch` had no gate at all before this: an Application with a transport
 * configured sent everything it was asked to send, and nothing could stop it,
 * not globally, not per event, not for one address. A product whose own backend
 * already sends transactional mail therefore delivered two of everything.
 *
 * The three gates are easy. The two things worth testing hard are the ways a
 * naive implementation of them goes wrong:
 *
 *   1. **A suppression must not become a token disclosure.** `no_transport` is
 *      the documented contract that hands a RAW reset token back to the API
 *      caller so a self-hoster can deliver it. If a suppressed send reported
 *      itself that way, "we turned email off" would quietly mean "the API now
 *      returns live password-reset tokens in its responses".
 *   2. **Disabling an essential event must be refused, not merely warned about.**
 *      Switching off `password_reset` while password sign-in is live removes the
 *      only way a user who forgets their password gets back in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';

interface World {
  ownerToken: string;
  applicationId: string;
  publishableKey: string;
  tag: string;
}

describe('email send control', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.95.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }

  async function world(): Promise<World> {
    currentIp = `10.95.${++n}.1`;
    const tag = `mail-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `owner-${tag}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Mail Co',
      },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const appRes = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Mail app', slug: tag },
    });
    expect(appRes.statusCode).toBe(201);
    const application = appRes.json().data as { id: string; publicKey: string };
    return { ownerToken, applicationId: application.id, publishableKey: application.publicKey, tag };
  }

  const auth = (w: World) => ({ authorization: `Bearer ${w.ownerToken}` });
  const base = (w: World) => `/api/v1/tenant/applications/${w.applicationId}`;

  async function makeEndUser(w: World, email: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: `${base(w)}/end-users`,
      headers: auth(w),
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  /** Dispatch straight through the service, so the gate is what is under test. */
  /** A live SECRET key: the caller the no-transport contract hands tokens to. */
  async function secretKey(w: World): Promise<string> {
    const key = await inject({
      method: 'POST',
      url: `${base(w)}/api-keys`,
      headers: auth(w),
      payload: { name: 'test', mode: 'live' },
    });
    expect(key.statusCode).toBe(201);
    return (key.json().data as { rawKey: string }).rawKey;
  }

  /**
   * Leave no auth method depending on email, so the master switch may be
   * turned off through the API. A fresh Application offers password sign-in,
   * which needs the reset email, and the switch refuses while it does.
   */
  async function dropEmailDependence(w: World): Promise<void> {
    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { methods: ['oauth'], requireEmailVerification: false },
    });
    expect(res.statusCode).toBe(200);
  }

  async function send(w: World, to: string) {
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: w.applicationId },
    });
    return emailService.dispatch({
      application,
      eventKey: 'welcome',
      to,
      variables: { userEmail: to, appUrl: 'https://app.example.com' },
    });
  }

  // ---------- the three gates ----------

  it('defaults to enabled, and nothing is suppressed until somebody says so', async () => {
    const w = await world();
    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { emailsEnabled: boolean; events: Array<{ enabled: boolean }> };
    expect(data.emailsEnabled).toBe(true);
    expect(data.events.length).toBe(9);
    expect(data.events.every((e) => e.enabled)).toBe(true);
  });

  it('the master switch suppresses a send, and records it as suppressed', async () => {
    const w = await world();
    await dropEmailDependence(w);
    const patch = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    expect(patch.statusCode).toBe(200);

    const outcome = await send(w, 'someone@example.com');
    expect(outcome.kind).toBe('error');

    // Recorded, not silently dropped: "why did they not get it" has to be
    // answerable in the one place an operator looks for send outcomes.
    const log = await prisma.emailLog.findFirstOrThrow({
      where: { applicationId: w.applicationId },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.status).toBe('suppressed');
    expect(log.error).toContain('switched off');
  });

  it('a disabled event suppresses only that event', async () => {
    const w = await world();
    const off = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/welcome`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);

    expect((await send(w, 'a@example.com')).kind).toBe('error');

    // A different event is untouched. No transport is configured in test, so
    // the honest outcome for an allowed send is `no_transport`, which is
    // exactly what distinguishes "not sent because we cannot" from "not sent
    // because you said not to".
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: w.applicationId },
    });
    const other = await emailService.dispatch({
      application,
      eventKey: 'mfa_enabled',
      to: 'a@example.com',
      variables: { userEmail: 'a@example.com', enabledAtIso: new Date().toISOString() },
    });
    expect(other.kind).toBe('no_transport');
  });

  it('a suppressed address is refused while everyone else is not', async () => {
    const w = await world();
    const add = await inject({
      method: 'POST',
      url: `${base(w)}/email-suppressions`,
      headers: auth(w),
      payload: { address: 'Bounced@Example.com', reason: 'bounce', note: 'hard bounce' },
    });
    expect(add.statusCode).toBe(201);
    // Stored lowercased, so the unique index is a real guarantee and the
    // lookup in `dispatch` cannot miss on casing.
    expect(add.json().data.address).toBe('bounced@example.com');

    expect((await send(w, 'BOUNCED@example.com')).kind).toBe('error');
    expect((await send(w, 'fine@example.com')).kind).toBe('no_transport');

    const removed = await inject({
      method: 'DELETE',
      url: `${base(w)}/email-suppressions/bounced@example.com`,
      headers: auth(w),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.removed).toBe(true);
    expect((await send(w, 'bounced@example.com')).kind).toBe('no_transport');

    // Idempotent.
    const again = await inject({
      method: 'DELETE',
      url: `${base(w)}/email-suppressions/bounced@example.com`,
      headers: auth(w),
    });
    expect(again.json().data.removed).toBe(false);
  });

  // ---------- the token-disclosure trap ----------

  it('turning email off does NOT start returning raw reset tokens', async () => {
    // The whole reason a suppression reports as `error` rather than
    // `no_transport`. With no transport configured, the reset path deliberately
    // hands the raw token back so a self-hoster can deliver it themselves. If
    // suppression took that branch, switching email off would silently turn the
    // API into a token dispenser.
    const w = await world();
    await makeEndUser(w, 'reset-me@example.com');

    // A SECRET key, deliberately: a publishable caller is given a constant
    // response that hides everything, so it could never observe this either
    // way. The secret-key caller is the one the no-transport contract hands
    // the token to, which makes it the one at risk.
    const key = await inject({
      method: 'POST',
      url: `${base(w)}/api-keys`,
      headers: auth(w),
      payload: { name: 'test', mode: 'live' },
    });
    expect(key.statusCode).toBe(201);
    const secret = (key.json().data as { rawKey: string }).rawKey;

    const forgot = () =>
      inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${secret}` },
        payload: { email: 'reset-me@example.com' },
      });

    // Baseline: no transport is configured in test, so the documented contract
    // applies and the caller really is handed a live token to deliver.
    const before = await forgot();
    expect(before.statusCode).toBe(200);
    expect(before.json().data.resetToken).toEqual(expect.any(String));

    // Written straight to the row: the API refuses this state now (password
    // sign-in is live, so the master switch is blocked), but a row from before
    // that refusal existed can still carry it, and `dispatch` must keep the
    // token withheld for such a row rather than trust the route to have
    // prevented it.
    await prisma.application.update({
      where: { id: w.applicationId },
      data: { emailsEnabled: false },
    });

    // And now the point: same caller, same route, email switched off. The token
    // must be withheld. If this ever returns a string again, turning email off
    // has silently become a token dispenser.
    const after = await forgot();
    expect(after.statusCode).toBe(200);
    expect(after.json().data.resetToken).toBeNull();
  });

  // ---------- essential events are coupled to the auth config ----------

  it('refuses to disable the password-reset email while password sign-in is live', async () => {
    const w = await world();
    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/password_reset`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG');
    // The refusal has to name the thing to change, or it is just a wall.
    expect(res.json().error.fix).toMatch(/password sign-in/i);
  });

  it('allows it once password sign-in is actually turned off', async () => {
    const w = await world();
    const patched = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { methods: ['magic_link'] },
    });
    expect(patched.statusCode).toBe(200);

    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/password_reset`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    // And the magic-link mail is now the one that cannot be disabled.
    const blocked = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/magic_link_signin`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(blocked.statusCode).toBe(409);
  });

  it('reports which events are blocked, and why, without being asked to change them', async () => {
    const w = await world();
    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
    });
    const events = res.json().data.events as Array<{
      key: string;
      essentialBlocker: { code: string } | null;
    }>;
    const blocked = events.filter((e) => e.essentialBlocker !== null).map((e) => e.key);
    // Password sign-in is on by default; verification is not required by
    // default; magic link is not enabled by default.
    expect(blocked).toContain('password_reset');
    expect(events.find((e) => e.key === 'welcome')?.essentialBlocker).toBeNull();
  });

  // ---------- an unknown event is a 404, not a 500 ----------

  it('an unknown event key is refused as not-found', async () => {
    const w = await world();
    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/not_a_real_event`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EMAIL_EVENT_UNKNOWN');
  });

  // ---------- stats ----------

  it('counts a suppressed send as suppressed, not as an error', async () => {
    const w = await world();
    await dropEmailDependence(w);
    await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    await send(w, 'x@example.com');

    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-stats?hours=24`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json().data as { suppressed: number; error: number };
    expect(stats.suppressed).toBe(1);
    expect(stats.error).toBe(0);
  });

  // ---------- what the first review found missing ----------

  it('a suppressed send is FILTERABLE on the delivery log, and carries its reason', async () => {
    const w = await world();
    // The copy on Settings and Templates both point an operator here to find
    // out why a mail did not go. Until the fourth status was accepted by the
    // query, `?status=suppressed` was a 400 and the reason was never rendered.
    await inject({
      method: 'POST',
      url: `${base(w)}/email-suppressions`,
      headers: auth(w),
      payload: { address: `blocked-${w.tag}@example.com`, reason: 'complaint' },
    });
    await send(w, `blocked-${w.tag}@example.com`);

    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-logs?status=suppressed`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    const rows = (res.json().data as { items: Array<{ status: string; error: string | null }> })
      .items;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('suppressed');
    // The reason is the entire point of showing the row.
    expect(rows[0]!.error).toContain('suppression list');
  });

  it('marks a suppression as such, so the alarm paths can tell it from a broken transport', async () => {
    const w = await world();
    await inject({
      method: 'POST',
      url: `${base(w)}/email-suppressions`,
      headers: auth(w),
      payload: { address: 'flagged@example.com', reason: 'bounce' },
    });

    // This flag is what lets `auth.service.ts` skip
    // `recordAuthEmailDeliveryFailure` for a suppression. Without it an
    // operator who switches an event off, or suppresses one complaining
    // address, then finds their own activity feed filling with
    // `auth.email_delivery_failed` alerts about the change they just made.
    //
    // Asserted on the OUTCOME rather than by counting security-event rows:
    // `recordAuthEmailDeliveryFailure` is called with `void`, so a row count
    // races the write and would pass whether the guard worked or not.
    const suppressed = await send(w, 'flagged@example.com');
    expect(suppressed.kind).toBe('error');
    expect(suppressed.kind === 'error' && suppressed.suppressed).toBe(true);

    // And it is set ONLY for a suppression, a real transport failure must
    // still raise the alarm, which is the whole point of the distinction.
    const normal = await send(w, 'fine@example.com');
    expect(normal.kind).toBe('no_transport');
    expect((normal as { suppressed?: true }).suppressed).toBeUndefined();
  });

  it('a suppressed reset STILL withholds the token — the alarm guard must not open that door', async () => {
    const w = await world();
    const email = `guard-${w.tag}@example.com`;
    await makeEndUser(w, email);
    await inject({
      method: 'POST',
      url: `${base(w)}/email-suppressions`,
      headers: auth(w),
      payload: { address: email, reason: 'manual' },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { authorization: `Bearer ${await secretKey(w)}` },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    // A secret-key caller is exactly the one `no_transport` would hand a live
    // token to, which makes it the one at risk from the alarm guard.
    expect(res.json().data.resetToken).toBeNull();
  });

  it('a test send refuses a suppressed address, but still ignores the master switch', async () => {
    const w = await world();
    const email = `test-${w.tag}@example.com`;

    // Master switch off: a test send is how an operator proves transport
    // before turning sending back on, so it must still be attempted.
    await dropEmailDependence(w);
    await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    const okRes = await inject({
      method: 'POST',
      url: `${base(w)}/email-templates/welcome/test-send`,
      headers: auth(w),
      payload: { to: email },
    });
    expect(okRes.statusCode).toBe(200);

    // Suppression list: mailing a complainant again is how a sending domain
    // gets blocked. "It was only a test" is not a distinction the receiving
    // mailbox provider makes.
    await inject({
      method: 'POST',
      url: `${base(w)}/email-suppressions`,
      headers: auth(w),
      payload: { address: email, reason: 'complaint' },
    });
    const refused = await inject({
      method: 'POST',
      url: `${base(w)}/email-templates/welcome/test-send`,
      headers: auth(w),
      payload: { to: email },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('EMAIL_ADDRESS_SUPPRESSED');
  });

  it('the two workspace-scoped events are marked, and their switch is refused', async () => {
    const w = await world();
    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
    });
    const events = (res.json().data as { events: Array<{ key: string; systemScoped: boolean }> })
      .events;
    const scoped = events.filter((e) => e.systemScoped).map((e) => e.key).sort();
    expect(scoped).toEqual(['billing_unapplied_payment', 'workspace_invitation']);

    // A switch that stores a setting nothing reads is the worst kind: the
    // operator is certain they turned it off and it keeps arriving.
    const refused = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/workspace_invitation`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('EMAIL_EVENT_NOT_APPLICATION_SCOPED');
  });

  it('the auth-config route closes the coupling from the other end', async () => {
    const w = await world();
    // The three-step walk-around: verification off, verification email off,
    // verification back on. Without the check on the auth-config route, every
    // subsequent sign-up is stranded waiting for a mail nothing will send.
    const off = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { requireEmailVerification: false },
    });
    expect(off.statusCode).toBe(200);

    const disabled = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/email_verification`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    const backOn = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { requireEmailVerification: true },
    });
    expect(backOn.statusCode).toBe(409);
    expect(backOn.json().error.code).toBe('EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG');
  });

  // ---------- the master switch is held to the same rule ----------

  it('refuses to switch all email off while password sign-in is live', async () => {
    // `dispatch` checks the master switch before any per-event row, so with
    // it off the password-reset email is silenced whatever its own switch
    // says, and a user who forgets their password has no way back in and no
    // refusal telling the operator why. The per-event switch already refuses
    // this; the master switch has to, or the lock on one door is beside an
    // open window.
    const w = await world();
    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG');
    expect(res.json().error.fix).toMatch(/password sign-in/i);
    // Nothing was written: the row still sends.
    const row = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
    expect(row.emailsEnabled).toBe(true);

    // The refusal names every live dependency, not just the first.
    const verify = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { requireEmailVerification: true },
    });
    expect(verify.statusCode).toBe(200);
    const both = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    expect(both.statusCode).toBe(409);
    expect(both.json().error.fix).toMatch(/password sign-in/i);
    expect(both.json().error.fix).toMatch(/require email verification/i);
  });

  it('switching all email off is allowed once no auth method depends on it, and turning it ON is always allowed', async () => {
    const w = await world();
    await dropEmailDependence(w);
    const off = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json().data as { emailsEnabled: boolean }).emailsEnabled).toBe(false);

    // Re-enabling can never be blocked: it is the remedy.
    const on = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: true },
    });
    expect(on.statusCode).toBe(200);
  });

  it('a disabled master switch blocks the auth-config route the way a disabled event does', async () => {
    // The three-step walk-around, master-switch edition: drop every
    // email-dependent method, switch all email off, add password sign-in
    // back. Without the master switch counting as "every event is off", the
    // third step would succeed with every per-event row still enabled, and
    // the Application would offer password sign-in with no reset path.
    const w = await world();
    await dropEmailDependence(w);
    const off = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    expect(off.statusCode).toBe(200);

    const backOn = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { methods: ['oauth', 'password'] },
    });
    expect(backOn.statusCode).toBe(409);
    expect(backOn.json().error.code).toBe('EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG');
    // The fix points at the switch that is actually off, not at per-event
    // toggles that are all still on.
    expect(backOn.json().error.fix).toMatch(/send control/i);
    expect(backOn.json().error.fix).not.toMatch(/"password_reset"/);

    const verification = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { requireEmailVerification: true },
    });
    expect(verification.statusCode).toBe(409);
    expect(verification.json().error.code).toBe('EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG');

    // A patch that touches neither coupled field is not held hostage.
    const unrelated = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { deviceBinding: 'optional' },
    });
    expect(unrelated.statusCode).toBe(200);

    // And the service answers the same for the operator MCP tool's path.
    const blockers = await emailService.authConfigBlockers(w.applicationId, {
      methods: ['password'],
      requireEmailVerification: false,
    });
    expect(blockers).toEqual([
      expect.objectContaining({ eventKey: 'password_reset', cause: 'master_switch' }),
    ]);

    // Email back on, and the same change goes through.
    await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: true },
    });
    const allowed = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { methods: ['oauth', 'password'] },
    });
    expect(allowed.statusCode).toBe(200);
  });

  // ---------- the two ends of the coupling cannot race past each other ----------

  // Each end checks the other's state and then writes. Unserialised, "email
  // off" and "password sign-in on" each pass against the other's old value and
  // both commit. Two racers under Promise.all do not reliably overlap in
  // Postgres, so each round fires eight of each, over several rounds.
  const RACERS = 8;
  const ROUNDS = 4;

  it('email off and password sign-in on, fired together, never both land', async () => {
    const w = await world();
    let bothLanded = 0;
    for (let round = 0; round < ROUNDS; round++) {
      await inject({
        method: 'PATCH',
        url: `${base(w)}/email-send-control`,
        headers: auth(w),
        payload: { emailsEnabled: true },
      });
      await dropEmailDependence(w);
      const results = await Promise.all(
        Array.from({ length: RACERS * 2 }, (_, i) =>
          i % 2 === 0
            ? inject({
                method: 'PATCH',
                url: `${base(w)}/email-send-control`,
                headers: auth(w),
                payload: { emailsEnabled: false },
              })
            : inject({
                method: 'PATCH',
                url: `${base(w)}/auth-config`,
                headers: auth(w),
                payload: { methods: ['oauth', 'password'] },
              }),
        ),
      );
      // Every request was decided, not crashed: 200 or the documented 409.
      for (const r of results) expect([200, 409]).toContain(r.statusCode);
      const row = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
      const methods = ((row.authConfig ?? {}) as { methods?: string[] }).methods ?? [];
      if (row.emailsEnabled === false && methods.includes('password')) bothLanded++;
    }
    expect(bothLanded).toBe(0);
  });

  it('the per-event switch takes the same lock: password_reset off and password sign-in on never both land', async () => {
    const w = await world();
    let bothLanded = 0;
    for (let round = 0; round < ROUNDS; round++) {
      await inject({
        method: 'PATCH',
        url: `${base(w)}/email-send-control/password_reset`,
        headers: auth(w),
        payload: { enabled: true },
      });
      await dropEmailDependence(w);
      const results = await Promise.all(
        Array.from({ length: RACERS * 2 }, (_, i) =>
          i % 2 === 0
            ? inject({
                method: 'PATCH',
                url: `${base(w)}/email-send-control/password_reset`,
                headers: auth(w),
                payload: { enabled: false },
              })
            : inject({
                method: 'PATCH',
                url: `${base(w)}/auth-config`,
                headers: auth(w),
                payload: { methods: ['oauth', 'password'] },
              }),
        ),
      );
      for (const r of results) expect([200, 409]).toContain(r.statusCode);
      const row = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
      const methods = ((row.authConfig ?? {}) as { methods?: string[] }).methods ?? [];
      const setting = await prisma.emailEventSetting.findUnique({
        where: {
          applicationId_eventKey: { applicationId: w.applicationId, eventKey: 'password_reset' },
        },
      });
      if (setting?.enabled === false && methods.includes('password')) bothLanded++;
    }
    expect(bothLanded).toBe(0);
  });

});
