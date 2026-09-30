/**
 * The Overview's engagement data: `GET .../end-users/:euid/insights`. Kept out
 * of `shared.ts` because only the Overview reads it.
 */

import { apiGet, unlessBusy } from '@/lib/api';
import type { ProfileField, ProfileValue } from '@rekey.dev/shared-types';

export interface SignInSourceRow {
  platform: string;
  os: string | null;
  browser: string | null;
  appVersion: string | null;
  country: string | null;
  lastSeenAt: string;
  sessions: number;
  live: boolean;
}

export interface EndUserInsightsDto {
  signIns: {
    count: number;
    lastSignedInAt: string | null;
    lastSignInVia: string | null;
    firstSignedInAt: string | null;
    trackedSince: string;
  };
  activity: {
    lastActiveOn: string | null;
    last30: boolean[];
    /** The whole 63-day window, oldest first. Absent from an API older than the field. */
    last63?: boolean[];
    activeDaysLast7: number;
    activeDaysLast30: number;
  };
  platforms: { last: string | null; seen: string[]; lastCountry: string | null };
  sources: SignInSourceRow[];
  security: { mfaEnabled: boolean; passkeys: number; oauthProviders: string[] };
  profile: {
    fields: ProfileField[];
    answers: Record<string, ProfileValue>;
    onboardingCompletedAt: string | null;
    /** Absent from an API older than onboarding skip. */
    onboardingSkippedAt?: string | null;
    onboardingStatus?: 'pending' | 'completed' | 'skipped';
    missingRequired: string[];
  };
}

/**
 * Null on failure (an older API without the route, a grant that does not
 * cover it), so each tile can say it could not be read instead of claiming
 * zero sign-ins. A busy API is rethrown for the retrying error boundary.
 */
export function getEndUserInsights(applicationId: string, euid: string): Promise<EndUserInsightsDto | null> {
  return apiGet<EndUserInsightsDto>(
    `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}/insights`,
    { interruptOnAccessError: false },
  ).catch(unlessBusy(() => null));
}

const PLATFORM_LABEL: Record<string, string> = {
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  server: 'Server',
  mcp: 'MCP',
  other: 'Other',
};

/** `ios` → `iOS`. A platform this panel does not know yet is shown as the API sent it: it is a name, not an error code. */
export function platformLabel(platform: string): string {
  const label = PLATFORM_LABEL[platform];
  return label === undefined ? platform : label;
}

const VIA_LABEL: Record<string, string> = {
  password: 'password',
  magic_link: 'magic link',
  oauth: 'OAuth',
  passkey: 'passkey',
  mfa: 'password + MFA',
};

/** `magic_link` → `magic link`; an unknown method is shown as sent. */
export function signInViaLabel(via: string): string {
  const label = VIA_LABEL[via];
  return label === undefined ? via : label;
}

/** "Chrome on macOS", "iOS 2.1.0", "Server": the shortest honest name for a source. */
export function describeSource(s: Pick<SignInSourceRow, 'platform' | 'os' | 'browser' | 'appVersion'>): string {
  if (s.browser && s.os) return `${s.browser} on ${s.os}`;
  if (s.browser) return s.browser;
  const app = s.appVersion ? ` ${s.appVersion}` : '';
  return `${s.os && s.platform === 'other' ? s.os : platformLabel(s.platform)}${app}`;
}
