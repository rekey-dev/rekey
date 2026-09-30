import {
  describeClientUserAgent,
  onboardingStatus,
  type EndUserProfile,
  type OnboardingStatus,
  type ProfileField,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { ACTIVITY_WINDOW_DAYS, activeDays } from './daily-activity.js';
import { missingRequired, readProfile, readProfileSchema } from './profile-values.js';

const ACTIVITY_DAYS = 30;
const SESSIONS_SCANNED = 200;
const SOURCES_SHOWN = 5;

/** One place a user signs in from: sessions grouped by platform, OS, browser and country. */
export interface SignInSource {
  platform: string;
  os: string | null;
  browser: string | null;
  appVersion: string | null;
  country: string | null;
  /** When the newest session in the group was issued or last refreshed. */
  lastSeenAt: string;
  sessions: number;
  /** At least one session in the group is still live. */
  live: boolean;
}

export interface EndUserInsights {
  signIns: {
    count: number;
    lastSignedInAt: string | null;
    lastSignInVia: string | null;
    firstSignedInAt: string | null;
    /** `signInCount` and the active days are counted from here. */
    trackedSince: string;
    /** How the account was created; `unknown` when it predates the record. */
    createdVia: string;
  };
  activity: {
    lastActiveOn: string | null;
    /** The last 30 UTC days, oldest first, ending today. */
    last30: boolean[];
    last63: boolean[];
    activeDaysLast7: number;
    activeDaysLast30: number;
  };
  platforms: { last: string | null; seen: string[]; lastCountry: string | null };
  sources: SignInSource[];
  security: { mfaEnabled: boolean; passkeys: number; oauthProviders: string[] };
  profile: {
    fields: ProfileField[];
    answers: EndUserProfile;
    onboardingCompletedAt: string | null;
    onboardingSkippedAt: string | null;
    onboardingStatus: OnboardingStatus;
    missingRequired: string[];
  };
}

interface SessionRowLite {
  clientPlatform: string | null;
  clientOs: string | null;
  clientBrowser: string | null;
  clientAppVersion: string | null;
  country: string | null;
  userAgent: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  expiresAt: Date;
}

/**
 * Group recent sessions into the places a user signs in from, newest first.
 * Rows issued before the client columns existed are read from their stored
 * User-Agent instead.
 */
export function groupSignInSources(rows: readonly SessionRowLite[], now: Date = new Date()): SignInSource[] {
  const groups = new Map<string, SignInSource>();
  for (const row of rows) {
    const parsed = row.clientPlatform ? null : describeClientUserAgent(row.userAgent);
    const platform = row.clientPlatform ?? parsed!.platform;
    const os = row.clientPlatform ? row.clientOs : parsed!.os;
    const browser = row.clientPlatform ? row.clientBrowser : parsed!.browser;
    const key = [platform, os, browser, row.country].join('|');
    const live = row.revokedAt === null && row.expiresAt > now;
    const seen = row.createdAt.toISOString();
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        platform,
        os,
        browser,
        appVersion: row.clientAppVersion,
        country: row.country,
        lastSeenAt: seen,
        sessions: 1,
        live,
      });
      continue;
    }
    group.sessions += 1;
    group.live ||= live;
    if (seen > group.lastSeenAt) {
      group.lastSeenAt = seen;
      group.appVersion = row.clientAppVersion ?? group.appVersion;
    }
  }
  return [...groups.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, SOURCES_SHOWN);
}

/**
 * Everything the panel's end-user Overview shows beyond the account row, in
 * one read of indexed single-user queries: sign-in counters, the 30-day
 * activity strip, platforms, where they sign in from, security factors and
 * the onboarding answers.
 *
 * @example
 *   const insights = await endUserInsights(app.id, euid);
 */
export async function endUserInsights(applicationId: string, endUserId: string): Promise<EndUserInsights> {
  const user = await prisma.endUser.findUnique({
    where: { id: endUserId },
    select: {
      applicationId: true,
      signInCount: true,
      lastSignedInAt: true,
      lastSignInVia: true,
      createdVia: true,
      firstSignedInAt: true,
      lastActiveOn: true,
      activityBits: true,
      lastPlatform: true,
      platformsSeen: true,
      lastCountry: true,
      profile: true,
      onboardingCompletedAt: true,
      onboardingSkippedAt: true,
      application: { select: { activityTrackedSince: true, profileSchema: true } },
    },
  });
  if (!user || user.applicationId !== applicationId) {
    throw new RekeyError({
      statusCode: 404,
      code: 'END_USER_NOT_FOUND',
      message: `End-user "${endUserId}" not found in this Application.`,
      fix: 'Confirm the id belongs to this Application.',
    });
  }

  const [sessions, mfa, passkeys, identities] = await Promise.all([
    // One row per session: a refresh revokes the presented row and issues a
    // replacement with the same sessionId, so only a row that was never
    // replaced is a session's current state. Counting every row made one
    // session refreshed 40 times read as 41.
    prisma.refreshToken.findMany({
      where: { endUserId, replacedById: null },
      orderBy: { createdAt: 'desc' },
      take: SESSIONS_SCANNED,
      select: {
        clientPlatform: true,
        clientOs: true,
        clientBrowser: true,
        clientAppVersion: true,
        country: true,
        userAgent: true,
        createdAt: true,
        revokedAt: true,
        expiresAt: true,
      },
    }),
    prisma.mfaCredential.findUnique({ where: { endUserId }, select: { enrolledAt: true } }),
    prisma.webAuthnCredential.count({ where: { endUserId } }),
    prisma.oAuthIdentity.findMany({ where: { endUserId }, select: { provider: true }, distinct: ['provider'] }),
  ]);

  const last63 = activeDays(user.lastActiveOn, user.activityBits, ACTIVITY_WINDOW_DAYS);
  const days = last63.slice(-ACTIVITY_DAYS);
  const fields = readProfileSchema(user.application.profileSchema);
  const answers = readProfile(user.profile);
  return {
    signIns: {
      count: user.signInCount,
      lastSignedInAt: user.lastSignedInAt?.toISOString() ?? null,
      lastSignInVia: user.lastSignInVia,
      createdVia: user.createdVia ?? 'unknown',
      firstSignedInAt: user.firstSignedInAt?.toISOString() ?? null,
      trackedSince: user.application.activityTrackedSince.toISOString(),
    },
    activity: {
      lastActiveOn: user.lastActiveOn?.toISOString().slice(0, 10) ?? null,
      last30: days,
      last63,
      activeDaysLast7: days.slice(-7).filter(Boolean).length,
      activeDaysLast30: days.filter(Boolean).length,
    },
    platforms: { last: user.lastPlatform, seen: user.platformsSeen, lastCountry: user.lastCountry },
    sources: groupSignInSources(sessions),
    security: {
      mfaEnabled: mfa?.enrolledAt != null,
      passkeys,
      oauthProviders: identities.map((i) => i.provider).sort(),
    },
    profile: {
      fields,
      answers,
      onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      onboardingSkippedAt: user.onboardingSkippedAt?.toISOString() ?? null,
      onboardingStatus: onboardingStatus(user),
      missingRequired: missingRequired(fields, answers),
    },
  };
}
