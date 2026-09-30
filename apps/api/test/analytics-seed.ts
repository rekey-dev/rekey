/**
 * Seeded end users for the analytics tests, and a brute-force oracle that
 * recomputes the numbers in TypeScript from the same rows.
 */

import { prisma } from '../src/lib/prisma.js';

export interface SeedUser {
  id: string;
  createdAt: Date;
  lastActiveOn: string | null;
  bits: bigint | null;
  platform: string | null;
  country: string | null;
  via: string | null;
  createdVia: string | null;
  verified: boolean;
  erased: boolean;
  onboardingCompletedAt: Date | null;
  onboardingSkippedAt: Date | null;
  firstSignedInAt: Date | null;
  signInCount: number;
}

const DAY_MS = 86_400_000;

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** A deterministic PRNG so a failure reproduces. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PLATFORMS = ['web', 'ios', 'android', null];
const COUNTRIES = ['DE', 'US', 'IN', null];
const VIAS = ['password', 'magic_link', 'oauth', 'passkey', null];
const CREATED = ['password', 'magic_link', 'oauth:google', 'operator', null];

/**
 * Insert `count` users with random creation days (up to `spanDays` back),
 * activity bits, platforms and onboarding state.
 *
 * @example
 *   const users = await seedUsers(appId, 200, 1);
 */
export async function seedUsers(applicationId: string, count: number, seed: number, spanDays = 100): Promise<SeedUser[]> {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const today = utcToday();
  const users: SeedUser[] = [];
  for (let i = 0; i < count; i++) {
    const age = Math.floor(rand() * spanDays);
    const createdDay = shiftDay(today, -age);
    const createdAt = new Date(Date.parse(`${createdDay}T00:00:00Z`) + Math.floor(rand() * DAY_MS));
    let lastActiveOn: string | null = null;
    let bits: bigint | null = null;
    if (rand() < 0.8) {
      const lag = Math.floor(rand() * Math.min(age + 1, 90));
      lastActiveOn = shiftDay(today, -lag);
      bits = 1n;
      for (let k = 1; k < 63; k++) if (rand() < 0.15) bits |= 1n << BigInt(k);
    }
    const completed = rand() < 0.4 ? new Date(createdAt.getTime() + Math.floor(rand() * 3 * DAY_MS)) : null;
    const skipped = !completed && rand() < 0.2 ? new Date(createdAt.getTime() + 60_000) : null;
    users.push({
      id: `seed_${seed}_${i}`,
      createdAt,
      lastActiveOn,
      bits,
      platform: pick(PLATFORMS),
      country: pick(COUNTRIES),
      via: pick(VIAS),
      createdVia: pick(CREATED),
      verified: rand() < 0.7,
      erased: rand() < 0.05,
      onboardingCompletedAt: completed,
      onboardingSkippedAt: skipped,
      firstSignedInAt: lastActiveOn ? new Date(createdAt.getTime() + 1000) : null,
      signInCount: lastActiveOn ? 1 + Math.floor(rand() * 5) : 0,
    });
  }
  for (const u of users) {
    await prisma.$executeRaw`
      INSERT INTO "end_users" ("id", "application_id", "email", "email_verified", "created_at", "updated_at",
        "last_active_on", "activity_bits", "last_platform", "last_country", "last_sign_in_via", "created_via",
        "erased_at", "onboarding_completed_at", "onboarding_skipped_at", "first_signed_in_at", "sign_in_count")
      VALUES (${u.id}, ${applicationId}, ${`${u.id}@example.com`}, ${u.verified}, ${u.createdAt}, ${u.createdAt},
        ${u.lastActiveOn}::date, ${u.bits === null ? null : u.bits.toString(2).padStart(63, '0')}::bit(63),
        ${u.platform}, ${u.country}::char(2), ${u.via}, ${u.createdVia},
        ${u.erased ? new Date() : null}::timestamp, ${u.onboardingCompletedAt}::timestamp, ${u.onboardingSkippedAt}::timestamp,
        ${u.firstSignedInAt}::timestamp, ${u.signInCount})`;
  }
  return users;
}

/** Was the user active on `day`? */
export function activeOn(u: SeedUser, day: string): boolean {
  if (!u.lastActiveOn || u.bits === null) return false;
  const k = Math.round((Date.parse(`${u.lastActiveOn}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
  if (k < 0 || k > 62) return false;
  return ((u.bits >> BigInt(k)) & 1n) === 1n;
}

/** Active on any of the `span` days ending `day`. */
export function activeWithin(u: SeedUser, day: string, span: number): boolean {
  for (let i = 0; i < span; i++) if (activeOn(u, shiftDay(day, -i))) return true;
  return false;
}
