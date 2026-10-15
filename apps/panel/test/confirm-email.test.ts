/**
 * The operator confirmation pages.
 *
 * Two properties are worth pinning from the source, because nothing at
 * runtime would show their loss until it mattered:
 *
 *   - The link page spends the token only when the button is pressed. A page
 *     that confirmed on load would let a mail scanner ratify a sign-up the
 *     mailbox owner never made (confirming keeps the sign-up password).
 *   - The actions redirect and never revalidate, like every action in the
 *     panel (see the note at the top of `(authed)/layout.tsx`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIRM_SEND_ERRORS } from '../src/lib/confirm-email-errors';
import { normalizeErrorCode } from '../src/lib/error-code';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');

describe('operator email confirmation in the panel', () => {
  const verifyPage = read('app/verify-email/page.tsx');
  const layout = read('app/(authed)/layout.tsx');

  it('the link page calls the API from its server action only, never while rendering, and with the session', () => {
    const action = verifyPage.slice(verifyPage.indexOf('async function confirm('), verifyPage.indexOf('const ERR'));
    const render = verifyPage.slice(verifyPage.indexOf('export default async function VerifyEmailPage'));
    expect(action).toContain("'use server'");
    expect(action).toContain("api<{ ok: true }>({ method: 'POST', path: '/api/v1/tenant/auth/verify-email', body: { token } })");
    expect(verifyPage, 'the session-less client would send no session').not.toContain('publicPost');
    expect(render).not.toContain('api<');
    expect(render).not.toContain('/api/v1/');
    expect(render).toContain('action={confirm}');
  });

  it('a signed-out visitor is sent to sign in and back, and is offered the sign-in link if the account is not theirs', () => {
    const render = verifyPage.slice(verifyPage.indexOf('export default async function VerifyEmailPage'));
    const signedOut = render.slice(render.indexOf('if (!signedIn) {'), render.indexOf('<AuthCard action={confirm}'));
    expect(signedOut).toContain('href={signInPath(token)}');
    expect(signedOut).toContain('href="/magic-link"');
    expect(signedOut).toContain('If you did not create this account, do not confirm it.');
    expect(signedOut, 'no confirm form without a session').not.toContain('action={confirm}');
    expect(verifyPage).toContain('return `/login?next=${encodeURIComponent(`/verify-email?token=${encodeURIComponent(token)}`)}`;');
  });

  it('the sign-in round trip is a path the login page accepts', async () => {
    const { safeNext } = await import('../src/lib/safe-next');
    expect(safeNext('/verify-email?token=abc-DEF_123')).toBe('/verify-email?token=abc-DEF_123');
  });

  it('the confirm form warns before the button', () => {
    expect(verifyPage).toContain('Only confirm if you created this account yourself.');
    expect(verifyPage.indexOf('Only confirm if you created this account yourself.')).toBeLessThan(
      verifyPage.indexOf('Confirm email\n      </SubmitButton>'),
    );
  });

  it('neither the send action nor the confirm action revalidates', () => {
    const send = layout.slice(layout.indexOf('async function sendConfirmationEmail('), layout.indexOf('export default async function AuthedLayout'));
    expect(send).toContain("path: '/api/v1/tenant/auth/resend-verification'");
    expect(send).toContain("redirect('/account/confirm-email')");
    expect(send).not.toContain('revalidatePath');
    expect(verifyPage).not.toContain('revalidatePath');
  });

  it('the notice is shown from the layout, on every page, only where confirmation is required', () => {
    expect(layout).toContain('!me.user.emailVerified && me.emailConfirmation?.required');
    expect(layout).toContain('me.emailConfirmation.byEmail && { sendAction: sendConfirmationEmail }');
  });

  it('every refusal the send route can answer has copy, and anything else falls back to the generic line', () => {
    for (const code of ['AUTH_EMAIL_RECIPIENT_CAPPED', 'OPERATOR_CONFIRMATION_EMAIL_UNAVAILABLE', 'RATE_LIMITED']) {
      expect(normalizeErrorCode(code, CONFIRM_SEND_ERRORS)).toBe(code);
      expect(CONFIRM_SEND_ERRORS[code]!.length).toBeGreaterThan(20);
    }
    expect(normalizeErrorCode('SOMETHING_NEW', CONFIRM_SEND_ERRORS)).toBe('unknown');
    expect(CONFIRM_SEND_ERRORS.unknown).toBeTruthy();
  });
});
