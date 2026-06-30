/**
 * Built-in default templates per transactional event.
 *
 * Tenants who don't customise a given event get this template at send
 * time. Editing in the panel writes an `EmailTemplate` row that overrides
 * the default for that (Application, eventKey) pair; deleting the row
 * reverts back to here.
 *
 * Templates are deliberately plain and inbox-safe — table layout, inline
 * styles, no external CSS, no images. Each one declares the variables it
 * uses; the renderer only substitutes registered names (see `events.ts`).
 */

import type { EmailEventKey } from '../events.js';

export interface DefaultTemplate {
  /** Default subject with {{var}} substitution. */
  subject: string;
  /** Inbox-safe HTML body. */
  html: string;
  /** Optional plain-text alternative; falls back to htmlToPlainText. */
  text?: string;
}

// Shared shell — single-column layout that renders predictably in Gmail,
// Outlook, Apple Mail. Brand-stripped on purpose; operators customise.
function shell(bodyHtml: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title> </title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f7;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #e5e5e7;">
      <tr><td style="padding:32px;color:#1d1d1f;font-size:15px;line-height:1.6;">
${bodyHtml}
      </td></tr>
    </table>
    <p style="color:#86868b;font-size:12px;margin:16px 0 0;">Sent via ReliPay</p>
  </td></tr>
</table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${href}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:500;">${label}</a></p>`;
}

export const DEFAULT_TEMPLATES: Record<EmailEventKey, DefaultTemplate> = {
  password_reset: {
    subject: 'Reset your password',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">Reset your password</h1>
<p style="margin:0 0 12px;">Hi {{userEmail}},</p>
<p style="margin:0 0 12px;">We received a request to reset your password. Click the button below to choose a new one. This link is valid until <strong>{{expiresAtIso}}</strong>.</p>
${button('{{resetUrl}}', 'Reset password')}
<p style="margin:0 0 12px;color:#86868b;font-size:13px;">If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
`),
  },
  email_verification: {
    subject: 'Verify your email address',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">Verify your email</h1>
<p style="margin:0 0 12px;">Hi {{userEmail}},</p>
<p style="margin:0 0 12px;">Click the button below to confirm this is your email address. This link is valid until <strong>{{expiresAtIso}}</strong>.</p>
${button('{{verifyUrl}}', 'Verify email')}
<p style="margin:0 0 12px;color:#86868b;font-size:13px;">If you didn't sign up, you can ignore this email.</p>
`),
  },
  magic_link_signin: {
    subject: 'Sign in to your account',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">Sign in</h1>
<p style="margin:0 0 12px;">Hi {{userEmail}},</p>
<p style="margin:0 0 12px;">Click the button below to sign in. This link is valid for 15 minutes (until <strong>{{expiresAtIso}}</strong>) and can be used once.</p>
${button('{{signInUrl}}', 'Sign in')}
<p style="margin:0 0 12px;color:#86868b;font-size:13px;">If you didn't request this, you can safely ignore this email — no one can sign in without clicking the link.</p>
`),
  },
  workspace_invitation: {
    subject: '{{inviterName}} invited you to {{workspaceName}}',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">You're invited</h1>
<p style="margin:0 0 12px;">Hi {{inviteeEmail}},</p>
<p style="margin:0 0 12px;"><strong>{{inviterName}}</strong> has invited you to join the <strong>{{workspaceName}}</strong> workspace.</p>
${button('{{inviteUrl}}', 'Accept invitation')}
<p style="margin:0 0 12px;color:#86868b;font-size:13px;">This invitation expires on {{expiresAtIso}}.</p>
`),
  },
  welcome: {
    subject: 'Welcome',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">Welcome</h1>
<p style="margin:0 0 12px;">Hi {{userEmail}},</p>
<p style="margin:0 0 12px;">Thanks for signing up. We're glad to have you.</p>
${button('{{appUrl}}', 'Get started')}
`),
  },
  mfa_enabled: {
    subject: 'Two-factor authentication enabled',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">Two-factor authentication enabled</h1>
<p style="margin:0 0 12px;">Hi {{userEmail}},</p>
<p style="margin:0 0 12px;">Two-factor authentication was enabled on your account at {{enabledAtIso}}. From now on, sign-in will require a code from your authenticator app.</p>
<p style="margin:0 0 12px;color:#86868b;font-size:13px;">If you didn't enable this, contact support immediately.</p>
`),
  },
  password_changed: {
    subject: 'Your password was changed',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">Password changed</h1>
<p style="margin:0 0 12px;">Hi {{userEmail}},</p>
<p style="margin:0 0 12px;">Your password was changed at {{changedAtIso}}. Every other session has been signed out.</p>
<p style="margin:0 0 12px;color:#86868b;font-size:13px;">If you didn't change your password, reset it immediately and contact support.</p>
`),
  },
  billing_payment_failed_reminder: {
    subject: 'Action needed: your payment failed',
    html: shell(`
<h1 style="font-size:20px;margin:0 0 16px;font-weight:600;">Your payment didn't go through</h1>
<p style="margin:0 0 12px;">Hi {{userEmail}},</p>
<p style="margin:0 0 12px;">We couldn't collect the payment of <strong>{{amountDue}}</strong> for your <strong>{{planName}}</strong> subscription. We'll keep retrying automatically, but please check that your payment method is valid and has sufficient funds.</p>
<p style="margin:0 0 12px;">If the payment can't be completed by <strong>{{graceEndsAtIso}}</strong>, your subscription will be canceled.</p>
<p style="margin:0 0 12px;color:#86868b;font-size:13px;">Reminder {{attempt}} — if you've already updated your payment details, you can ignore this email.</p>
`),
  },
};
