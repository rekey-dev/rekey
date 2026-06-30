/**
 * Transactional email event registry.
 *
 * Each event maps to a stable string key (used as `EmailTemplate.eventKey`
 * column) and a *fixed* list of variable names it expects. The renderer
 * trusts only these variables — anything else passed at send-time is
 * dropped. This keeps the substitution surface small and predictable: no
 * arbitrary expressions, no helper functions, just `{{var}}` lookups.
 *
 * Adding a new event means: (1) add the entry below, (2) drop a default
 * HTML/subject pair in `defaults/`, (3) call `emailService.send(...)` from
 * the relevant flow.
 *
 * Variable values are always HTML-escaped at render time (see `render.ts`)
 * — never interpolate raw HTML from user-supplied strings.
 */

export type EmailEventKey =
  | 'password_reset'
  | 'email_verification'
  | 'magic_link_signin'
  | 'workspace_invitation'
  | 'welcome'
  | 'mfa_enabled'
  | 'password_changed'
  | 'billing_payment_failed_reminder';

export interface EmailEventDef {
  key: EmailEventKey;
  /** Short human label shown in the panel. */
  label: string;
  /** Variable names the renderer will substitute. */
  variables: readonly string[];
  /** Sample values used by the preview / test-send paths. */
  sampleValues: Record<string, string>;
}

export const EMAIL_EVENTS: Record<EmailEventKey, EmailEventDef> = {
  password_reset: {
    key: 'password_reset',
    label: 'Password reset',
    variables: ['userEmail', 'resetUrl', 'expiresAtIso'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      resetUrl: 'https://your-app.example.com/reset?token=…',
      expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  },
  email_verification: {
    key: 'email_verification',
    label: 'Email verification',
    variables: ['userEmail', 'verifyUrl', 'expiresAtIso'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      verifyUrl: 'https://your-app.example.com/verify?token=…',
      expiresAtIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  },
  magic_link_signin: {
    key: 'magic_link_signin',
    label: 'Magic-link sign-in',
    variables: ['userEmail', 'signInUrl', 'expiresAtIso'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      signInUrl: 'https://your-app.example.com/sign-in/magic?token=…',
      expiresAtIso: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  },
  workspace_invitation: {
    key: 'workspace_invitation',
    label: 'Workspace invitation',
    variables: ['inviteeEmail', 'inviterName', 'workspaceName', 'inviteUrl', 'expiresAtIso'] as const,
    sampleValues: {
      inviteeEmail: 'newteammate@example.com',
      inviterName: 'Alex',
      workspaceName: 'Acme Inc',
      inviteUrl: 'https://your-app.example.com/accept-invite?token=…',
      expiresAtIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
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
    variables: ['userEmail', 'enabledAtIso'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      enabledAtIso: new Date().toISOString(),
    },
  },
  password_changed: {
    key: 'password_changed',
    label: 'Password changed',
    variables: ['userEmail', 'changedAtIso'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      changedAtIso: new Date().toISOString(),
    },
  },
  billing_payment_failed_reminder: {
    key: 'billing_payment_failed_reminder',
    label: 'Payment failed (dunning reminder)',
    variables: ['userEmail', 'planName', 'amountDue', 'attempt', 'graceEndsAtIso'] as const,
    sampleValues: {
      userEmail: 'sample@example.com',
      planName: 'Pro Monthly',
      amountDue: '9.99 USD',
      attempt: '1',
      graceEndsAtIso: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
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
