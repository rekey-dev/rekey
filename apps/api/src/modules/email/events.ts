/**
 * Transactional email event registry.
 *
 * Each event maps to a stable string key (used as `EmailTemplate.eventKey`
 * column) and a *fixed* list of variable names it expects. The renderer
 * trusts only these variables, anything else passed at send-time is
 * dropped. This keeps the substitution surface small and predictable: no
 * arbitrary expressions, no helper functions, just `{{var}}` lookups.
 *
 * Adding a new event means: (1) add the entry below, (2) write its default
 * copy in `defaults/index.ts`, (3) call `emailService.dispatch(...)` (or
 * `dispatchSystem(...)` for mail with no Application) from the relevant flow.
 *
 * Variable values are always HTML-escaped at render time (see `render.ts`),
 * never interpolate raw HTML from user-supplied strings.
 *
 * An event with an `xAtIso` variable also registers `xAt`, the same instant as
 * "27 Sep 2026, 14:50 UTC". Call sites pass only the ISO value; the renderer
 * derives the readable one.
 */

import { formatUtcDateTime } from './format-date.js';

export type EmailEventKey =
  | 'password_reset'
  | 'email_verification'
  | 'magic_link_signin'
  | 'workspace_invitation'
  | 'welcome'
  | 'mfa_enabled'
  | 'password_changed'
  | 'billing_payment_failed_reminder'
  | 'billing_unapplied_payment';

export interface EmailEventDef {
  key: EmailEventKey;
  /** Short human label shown in the panel. */
  label: string;
  /** Variable names the renderer will substitute. */
  variables: readonly string[];
  /** Sample values used by the preview / test-send paths. */
  sampleValues: Record<string, string>;
}

/**
 * A sample instant `ms` from now, as the ISO value and the readable value the
 * renderer derives from it (see `pickEventVariables`).
 */
function sampleAt(ms: number): { iso: string; plain: string } {
  const iso = new Date(Date.now() + ms).toISOString();
  return { iso, plain: formatUtcDateTime(iso) };
}

const HOUR = 60 * 60 * 1000;
const reset = sampleAt(HOUR);
const verify = sampleAt(24 * HOUR);
const magic = sampleAt(15 * 60 * 1000);
const invite = sampleAt(7 * 24 * HOUR);
const now = sampleAt(0);
const grace = sampleAt(14 * 24 * HOUR);

export const EMAIL_EVENTS: Record<EmailEventKey, EmailEventDef> = {
  password_reset: {
    key: 'password_reset',
    label: 'Password reset',
    variables: ['userEmail', 'resetUrl', 'expiresAtIso', 'expiresAt'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      resetUrl: 'https://your-app.example.com/reset?token=…',
      expiresAtIso: reset.iso,
      expiresAt: reset.plain,
    },
  },
  email_verification: {
    key: 'email_verification',
    label: 'Email verification',
    variables: ['userEmail', 'verifyUrl', 'expiresAtIso', 'expiresAt'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      verifyUrl: 'https://your-app.example.com/verify?token=…',
      expiresAtIso: verify.iso,
      expiresAt: verify.plain,
    },
  },
  magic_link_signin: {
    key: 'magic_link_signin',
    label: 'Magic-link sign-in',
    variables: ['userEmail', 'signInUrl', 'expiresAtIso', 'expiresAt'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      signInUrl: 'https://your-app.example.com/sign-in/magic?token=…',
      expiresAtIso: magic.iso,
      expiresAt: magic.plain,
    },
  },
  workspace_invitation: {
    key: 'workspace_invitation',
    label: 'Workspace invitation',
    variables: ['inviteeEmail', 'inviterName', 'workspaceName', 'inviteUrl', 'expiresAtIso', 'expiresAt'] as const,
    sampleValues: {
      inviteeEmail: 'newteammate@example.com',
      inviterName: 'Alex',
      workspaceName: 'Acme Inc',
      inviteUrl: 'https://your-app.example.com/accept-invite?token=…',
      expiresAtIso: invite.iso,
      expiresAt: invite.plain,
    },
  },
  welcome: {
    key: 'welcome',
    label: 'Welcome',
    variables: ['userEmail', 'appUrl'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      appUrl: 'https://your-app.example.com',
    },
  },
  mfa_enabled: {
    key: 'mfa_enabled',
    label: 'MFA enabled',
    variables: ['userEmail', 'enabledAtIso', 'enabledAt'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      enabledAtIso: now.iso,
      enabledAt: now.plain,
    },
  },
  password_changed: {
    key: 'password_changed',
    label: 'Password changed',
    variables: ['userEmail', 'changedAtIso', 'changedAt'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      changedAtIso: now.iso,
      changedAt: now.plain,
    },
  },
  billing_payment_failed_reminder: {
    key: 'billing_payment_failed_reminder',
    label: 'Payment failed (dunning reminder)',
    variables: [
      'userEmail',
      'planName',
      'amountDue',
      'attempt',
      'graceEndsAtIso',
      'graceEndsAt',
      'portalUrl',
    ] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      planName: 'Pro Monthly',
      amountDue: '9.99 USD',
      attempt: '1',
      graceEndsAtIso: grace.iso,
      graceEndsAt: grace.plain,
      portalUrl: 'https://portal.example.com/your-app',
    },
  },
  // Addressed to the OPERATOR, not to a buyer, the only event here that is.
  // It reports money the operator has received and Rekey could not attribute,
  // and asks them to decide what happens to it.
  billing_unapplied_payment: {
    key: 'billing_unapplied_payment',
    label: 'Unapplied payment received (operator)',
    variables: [
      'amount',
      'provider',
      'providerPaymentId',
      'endUserEmail',
      'receivedAtIso',
      'receivedAt',
    ] as const,
    sampleValues: {
      amount: '9.99 USD',
      provider: 'stripe',
      providerPaymentId: 'pi_3QSampleSample',
      endUserEmail: 'sample@example.com',
      receivedAtIso: now.iso,
      receivedAt: now.plain,
    },
  },
};

export function isKnownEvent(key: string): key is EmailEventKey {
  return key in EMAIL_EVENTS;
}

/** Strongly-typed variable map for a given event. */
export type EventVariables<K extends EmailEventKey> = Record<
  (typeof EMAIL_EVENTS)[K]['variables'][number],
  string
>;
