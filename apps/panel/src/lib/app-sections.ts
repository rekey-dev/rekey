/**
 * The per-Application sections, grouped the way AppNav shows them. AppNav and
 * the command palette both read this list, so a section added here appears in
 * both places.
 */

import type { Scope } from '@/lib/operator-scopes';

export interface AppSection {
  /** Path segment under `/applications/{id}`. Empty string = the Application landing. */
  seg: string;
  label: string;
  /** Extra words the command palette matches on. */
  keywords?: string;
}

export interface AppSectionGroup {
  key: string;
  label: string;
  sections: AppSection[];
}

/**
 * Which scope a section needs to be worth showing. Mirrors the API's route
 * declarations (`config.access` on each route), a section whose reads would
 * all 403 is not offered. `null` = always shown: the landing page and
 * Settings, which floor themselves.
 *
 * This is presentation, not enforcement (see Sidebar.tsx). The API refuses
 * on its own; this stops the panel showing somebody a door that will slam.
 */
export const SEG_SCOPE: Record<string, Scope | null> = {
  '': null,
  users: 'overview:read',
  'end-users': 'end-users:read',
  onboarding: 'end-users:read',
  roles: 'organizations:read',
  organizations: 'organizations:read',
  activity: 'activity:read',
  lists: 'audience:read',
  auth: 'auth-config:read',
  oauth: 'auth-config:read',
  'oauth-clients': 'auth-config:read',
  mcp: 'auth-config:read',
  revenue: 'billing:read',
  billing: 'billing:read',
  plans: 'billing:read',
  payments: 'billing:read',
  dunning: 'billing:read',
  'unapplied-payments': 'billing:read',
  imports: 'billing:read',
  coupons: 'billing:read',
  licenses: 'billing:read',
  usage: 'billing:read',
  // The API declares the portal routes under auth-config (they write the
  // Application's portal settings), not billing, so a billing-only grant
  // could open this page but never save it.
  portal: 'auth-config:read',
  'api-keys': 'developer:read',
  webhooks: 'developer:read',
  requests: 'activity:read',
  access: 'auth-config:read',
  settings: null,
  lifecycle: null,
  email: 'developer:read',
};

/**
 * Billing children the API gates behind `requireBillingEnabled`. While billing
 * is off they stay in the group (so their paths resolve and get a sub-row) but
 * are not offered unless you are standing on one. Setup is the one billing page
 * that is never gated: it is where billing is turned on.
 */
export const BILLING_GATED_SEGS: readonly string[] = [
  'revenue',
  'plans',
  'payments',
  'dunning',
  'unapplied-payments',
  'imports',
  'coupons',
  'licenses',
  'usage',
  'portal',
];

export const APP_SECTION_GROUPS: AppSectionGroup[] = [
  { key: 'overview', label: 'Overview', sections: [{ seg: '', label: 'Overview', keywords: 'dashboard stats' }] },
  {
    key: 'users',
    label: 'Users',
    sections: [
      { seg: 'users', label: 'Overview', keywords: 'analytics active users dau mau retention funnel' },
      { seg: 'end-users', label: 'End-users', keywords: 'users customers accounts' },
      { seg: 'onboarding', label: 'Onboarding', keywords: 'profile fields questions schema skip complete' },
      // Both role catalogs live here rather than on the two pages they
      // govern. Splitting them put the word "roles" on End-users and on
      // Organizations meaning different things, with no place to see the
      // difference; one page carries the distinction and both tables.
      { seg: 'roles', label: 'Roles', keywords: 'permissions organization roles' },
      { seg: 'organizations', label: 'Organizations', keywords: 'orgs teams' },
      { seg: 'activity', label: 'Activity', keywords: 'security events sign-ins' },
    ],
  },
  {
    key: 'audience',
    label: 'Audience',
    sections: [{ seg: 'lists', label: 'Lists', keywords: 'waitlist newsletter contact form subscribers audience' }],
  },
  {
    key: 'auth',
    label: 'Authentication',
    sections: [
      { seg: 'auth', label: 'Methods', keywords: 'authentication password sign-in mfa magic link passkeys' },
      // Two directions, and the labels are the only thing that keeps them
      // apart: "Sign-in providers" is outbound (who your users may sign in
      // WITH); "OAuth clients" is inbound (apps that sign users in USING this
      // Application). Naming both of them "OAuth" is what made an operator
      // paste a client id into the provider form.
      { seg: 'oauth', label: 'Sign-in providers', keywords: 'oauth google microsoft github social' },
      { seg: 'oauth-clients', label: 'OAuth clients', keywords: 'oidc identity provider inbound' },
      { seg: 'mcp', label: 'MCP', keywords: 'model context protocol agents' },
    ],
  },
  {
    key: 'billing',
    label: 'Billing',
    sections: [
      { seg: 'revenue', label: 'Overview', keywords: 'revenue mrr chart billing' },
      { seg: 'billing', label: 'Setup', keywords: 'billing providers stripe paypal razorpay credentials' },
      { seg: 'plans', label: 'Plans', keywords: 'pricing subscription' },
      { seg: 'coupons', label: 'Coupons', keywords: 'discounts promo' },
      { seg: 'usage', label: 'Meters', keywords: 'usage meters credits metered' },
      { seg: 'licenses', label: 'Licenses', keywords: 'license keys seats' },
      { seg: 'payments', label: 'Payments', keywords: 'charges refunds invoices' },
      { seg: 'unapplied-payments', label: 'Unapplied', keywords: 'unmatched payments' },
      { seg: 'dunning', label: 'Dunning', keywords: 'failed payments retries' },
      { seg: 'imports', label: 'Imports', keywords: 'migrate subscriptions import' },
      { seg: 'portal', label: 'Portal', keywords: 'customer billing portal' },
    ],
  },
  {
    key: 'developer',
    label: 'Developer',
    sections: [
      { seg: 'api-keys', label: 'API keys', keywords: 'secret keys publishable' },
      { seg: 'webhooks', label: 'Webhooks', keywords: 'endpoints deliveries events' },
      { seg: 'requests', label: 'Requests', keywords: 'request logs' },
      { seg: 'access', label: 'Allowed origins & IPs', keywords: 'access ip allowlist cors origins network' },
    ],
  },
  {
    key: 'email',
    label: 'Email',
    sections: [{ seg: 'email', label: 'Email', keywords: 'templates smtp resend sender delivery suppressions' }],
  },
  {
    key: 'settings',
    label: 'Settings',
    sections: [
      {
        seg: 'settings',
        label: 'Settings',
        keywords: 'lifecycle disable enable promote production sign out all end-users sessions kill switch',
      },
    ],
  },
];
