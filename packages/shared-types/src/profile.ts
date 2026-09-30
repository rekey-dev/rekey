import { z } from 'zod';

/** The kinds of answer a profile field holds. */
export const PROFILE_FIELD_TYPES = ['text', 'select', 'number', 'boolean', 'url', 'date'] as const;
export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

/** Most fields one Application may define. */
export const MAX_PROFILE_FIELDS = 50;
/** Longest `text` answer, in characters. */
export const MAX_PROFILE_TEXT = 500;

/**
 * Keys a field may not use: names every JavaScript object inherits, which an
 * `in` check or a bracket read would mistake for a stored answer.
 */
export const RESERVED_PROFILE_KEYS = ['constructor', 'prototype', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'] as const;

/**
 * One question in an Application's profile schema, the onboarding answers it
 * keeps on each end user under `EndUser.profile[key]`.
 *
 * @example
 *   { key: 'team_size', label: 'Team size', type: 'select', options: ['1', '2-10', '11+'], requiredForOnboarding: true }
 */
export const ProfileFieldSchema = z
  .object({
    /** Stable storage key: lowercase letters, digits and `_`, starting with a letter. Cannot change once answers exist. */
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use 1-40 lowercase letters, digits or _, starting with a letter.')
      .refine((k) => !(RESERVED_PROFILE_KEYS as readonly string[]).includes(k), 'This key is reserved; choose another.'),
    /** What the question says. Free to change at any time. */
    label: z.string().trim().min(1).max(80),
    type: z.enum(PROFILE_FIELD_TYPES),
    /** The allowed answers of a `select`. Required for `select`, refused for every other type. */
    options: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
    /** Must be answered before `onboarding/complete` succeeds. Governs that route only; Rekey never blocks sign-in on it. */
    requiredForOnboarding: z.boolean().default(false),
    /** `user`: the signed-in user may set it. `server`: only a secret key or an operator may. */
    writableBy: z.enum(['user', 'server']).default('user'),
    /** Show it as a column in the panel's end-user list. */
    showInList: z.boolean().default(false),
    /** Marks personal data (a phone number, say). Recorded now; not yet enforced. */
    pii: z.boolean().default(false),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select' && !field.options) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'A select field needs options.' });
    }
    if (field.type !== 'select' && field.options) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only a select field takes options.' });
    }
    if (field.options && new Set(field.options).size !== field.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique.' });
    }
  });
export type ProfileField = z.infer<typeof ProfileFieldSchema>;

/** The whole schema: an ordered list of fields with unique keys. */
export const ProfileSchemaSchema = z
  .array(ProfileFieldSchema)
  .max(MAX_PROFILE_FIELDS)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `Duplicate key "${f.key}".` });
      seen.add(f.key);
    });
  });

/** A stored answer: what each field type holds. `date` is `YYYY-MM-DD`. */
export type ProfileValue = string | number | boolean;

/** The answers on one end user, keyed by field key. */
export type EndUserProfile = Record<string, ProfileValue>;

/**
 * Where a user stands with onboarding. Rekey records it and never acts on it:
 * no sign-in, route or feature is gated on any value. Your app decides whether
 * a `pending` or `skipped` user is sent back to the onboarding form.
 */
export const ONBOARDING_STATUSES = ['pending', 'completed', 'skipped'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/**
 * `completed` once onboarding was completed (even after a skip), else
 * `skipped` once it was skipped, else `pending`.
 *
 * @example
 *   onboardingStatus({ onboardingCompletedAt: null, onboardingSkippedAt: '2026-09-30T10:00:00.000Z' }); // 'skipped'
 */
export function onboardingStatus(user: {
  onboardingCompletedAt: Date | string | null;
  onboardingSkippedAt: Date | string | null;
}): OnboardingStatus {
  if (user.onboardingCompletedAt) return 'completed';
  if (user.onboardingSkippedAt) return 'skipped';
  return 'pending';
}

/**
 * An end user's profile answers and onboarding state, as every profile and
 * onboarding write returns them.
 */
export interface ProfileStateDto {
  profile: EndUserProfile;
  onboardingCompletedAt: string | null;
  onboardingSkippedAt: string | null;
  onboardingStatus: OnboardingStatus;
}
