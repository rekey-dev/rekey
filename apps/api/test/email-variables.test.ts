/**
 * The variables the built-in emails are given, beyond what each call site
 * passes: readable UTC dates derived from the ISO ones, the hosted billing
 * portal link on the payment-failed email, and the "Secured by Rekey" line
 * that only a brand flagged for attribution carries.
 */

import { describe, expect, it } from 'vitest';
import { brandFromApplication, defaultTemplate } from '../src/modules/email/defaults/index.js';
import { EMAIL_EVENTS, type EmailEventKey } from '../src/modules/email/events.js';
import { formatUtcDateTime } from '../src/modules/email/format-date.js';
import { pickEventVariables, renderHtmlBody, renderTemplate } from '../src/modules/email/render.js';
import { hostedPortalUrl } from '../src/lib/portal-origins.js';

const EVENT_KEYS = Object.keys(EMAIL_EVENTS) as EmailEventKey[];
const ACME = { name: 'Acme', portalBranding: {} };

function render(key: EmailEventKey, supplied: Record<string, unknown>, attribution = false) {
  const t = defaultTemplate(key, brandFromApplication(ACME, { attribution }));
  const vars = pickEventVariables(key, supplied);
  return {
    html: renderHtmlBody(t.html, vars),
    text: renderTemplate(t.text, vars, { escape: false }),
    design: JSON.stringify(t.design),
  };
}

describe('formatUtcDateTime', () => {
  it('formats an ISO instant as a fixed en-GB style UTC string', () => {
    expect(formatUtcDateTime('2026-09-27T14:50:00.000Z')).toBe('27 Sep 2026, 14:50 UTC');
    expect(formatUtcDateTime('2026-01-05T03:07:59.999Z')).toBe('5 Jan 2026, 03:07 UTC');
  });

  it('converts an offset to UTC rather than printing local time', () => {
    expect(formatUtcDateTime('2026-09-27T20:20:00+05:30')).toBe('27 Sep 2026, 14:50 UTC');
    expect(formatUtcDateTime('2026-12-31T23:30:00-01:00')).toBe('1 Jan 2027, 00:30 UTC');
  });

  it('passes through a value that is not a date, and keeps an empty one empty', () => {
    expect(formatUtcDateTime('whenever')).toBe('whenever');
    expect(formatUtcDateTime('')).toBe('');
  });
});

describe('derived date variables', () => {
  it('every event that has an xAtIso variable also registers xAt, with a sample', () => {
    for (const key of EVENT_KEYS) {
      const { variables, sampleValues } = EMAIL_EVENTS[key];
      for (const iso of variables.filter((v) => v.endsWith('AtIso'))) {
        const plain = iso.slice(0, -'Iso'.length);
        expect(variables, `${key} registers ${plain}`).toContain(plain);
        expect(sampleValues[plain], `${key} samples ${plain}`).toBe(formatUtcDateTime(sampleValues[iso]!));
      }
    }
  });

  it('keeps expiresAtIso registered for templates written against it', () => {
    for (const key of ['password_reset', 'email_verification', 'magic_link_signin', 'workspace_invitation'] as const) {
      expect(EMAIL_EVENTS[key].variables).toContain('expiresAtIso');
      expect(EMAIL_EVENTS[key].variables).toContain('expiresAt');
    }
  });

  it('derives xAt from xAtIso when the caller passes only the ISO value', () => {
    const vars = pickEventVariables('password_reset', { userEmail: 'a@example.com', expiresAtIso: '2026-09-27T14:50:00.000Z' });
    expect(vars.expiresAt).toBe('27 Sep 2026, 14:50 UTC');
    expect(vars.expiresAtIso).toBe('2026-09-27T14:50:00.000Z');
  });

  it('the defaults show the readable date, not the ISO one', () => {
    const { html, text } = render('password_reset', {
      userEmail: 'a@example.com',
      resetUrl: 'https://app.example.com/r',
      expiresAtIso: '2026-09-27T14:50:00.000Z',
    });
    expect(text).toContain('This link expires at 27 Sep 2026, 14:50 UTC.');
    expect(html).toContain('27 Sep 2026, 14:50 UTC');
    expect(html).not.toContain('2026-09-27T14:50');
  });
});

describe('payment-failed portal button', () => {
  const base = {
    userEmail: 'a@example.com',
    planName: 'Pro',
    amountDue: '9.99 USD',
    attempt: '1',
    graceEndsAtIso: '2026-10-11T00:00:00.000Z',
  };

  it('registers portalUrl', () => {
    expect(EMAIL_EVENTS.billing_payment_failed_reminder.variables).toContain('portalUrl');
  });

  it('links "Update payment method" to the portal when there is one', () => {
    const { html, text, design } = render('billing_payment_failed_reminder', { ...base, portalUrl: 'https://portal.example.com/acme' });
    expect(html).toContain('>Update payment method</a>');
    expect(html).toContain('href="https://portal.example.com/acme"');
    expect(text).toContain('Update payment method:\nhttps://portal.example.com/acme');
    expect(design).toContain('{{portalUrl}}');
  });

  it('drops the button, and every link to it, when the Application has no portal', () => {
    const { html, text } = render('billing_payment_failed_reminder', { ...base, portalUrl: '' });
    expect(html).not.toContain('Update payment method');
    expect(html).not.toMatch(/href=""/);
    expect(text).not.toContain('Update payment method');
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe('hostedPortalUrl', () => {
  it('is the shared portal host plus the slug when the Application enabled it', () => {
    const origin = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
    expect(hostedPortalUrl({ slug: 'acme', hostedPortalEnabled: true })).toBe(`${origin}/acme`);
    expect(hostedPortalUrl({ slug: 'a b', hostedPortalEnabled: true })).toBe(`${origin}/a%20b`);
  });

  it('is null when the Application has not enabled it', () => {
    expect(hostedPortalUrl({ slug: 'acme', hostedPortalEnabled: false })).toBeNull();
  });
});

describe('Secured by Rekey attribution', () => {
  const vars = { userEmail: 'a@example.com', appUrl: 'https://app.example.com' };

  it('appears in the HTML and the text when the brand carries it', () => {
    const { html, text } = render('welcome', vars, true);
    expect(html).toMatch(/<a [^>]*href="https:\/\/rekey\.dev"[^>]*>Secured by Rekey<\/a>/);
    expect(text).toContain('Secured by Rekey: https://rekey.dev');
  });

  it('is absent by default', () => {
    const { html, text } = render('welcome', vars);
    expect(html).not.toContain('Secured by Rekey');
    expect(html).not.toContain('rekey.dev');
    expect(text).not.toContain('Secured by Rekey');
  });

  it('is never part of the editor design, so it cannot end up in a saved template', () => {
    expect(render('welcome', vars, true).design).not.toContain('Secured by Rekey');
  });
});
