/**
 * Lists and contacts: a newsletter, a waitlist or a contact form that stores
 * people who have no account yet. Operators manage lists under
 * `/api/v1/tenant/applications/:id/lists`. Error codes: docs/errors.md,
 * "Lists and contacts".
 */

import { z } from 'zod';

/** A list key: lowercase, starts with a letter, 3 to 64 characters. Permanent. */
export const CONTACT_LIST_KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** A custom field name as it appears in `fields`. */
export const CONTACT_FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const CONTACT_LIST_KINDS = ['newsletter', 'waitlist', 'contact_form', 'generic'] as const;
export type ContactListKind = (typeof CONTACT_LIST_KINDS)[number];

export const CONTACT_LAWFUL_BASES = ['consent', 'legitimate_interest', 'contract'] as const;
export type ContactLawfulBasis = (typeof CONTACT_LAWFUL_BASES)[number];

export const CONTACT_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'url',
  'select',
  'checkbox',
  'number',
] as const;
export type ContactFieldType = (typeof CONTACT_FIELD_TYPES)[number];

export const CONTACT_MAX_FIELDS = 20;
export const CONTACT_FIELD_DEFAULT_MAX_LENGTH = 500;
export const CONTACT_FIELD_MAX_LENGTH = 2000;
export const CONTACT_CONSENT_TEXT_MAX_LENGTH = 2000;

/**
 * One extra field a list collects beyond the email address and name.
 *
 * @example
 * ```ts
 * ContactFieldDefSchema.parse({ name: 'company', label: 'Company', type: 'text' });
 * ContactFieldDefSchema.parse({
 *   name: 'plan', label: 'Plan', type: 'select', required: true, options: ['solo', 'team'],
 * });
 * ```
 */
export const ContactFieldDefSchema = z
  .object({
    name: z.string().regex(CONTACT_FIELD_NAME_RE),
    label: z.string().trim().min(1).max(120),
    type: z.enum(CONTACT_FIELD_TYPES),
    required: z.boolean().default(false),
    maxLength: z
      .number()
      .int()
      .min(1)
      .max(CONTACT_FIELD_MAX_LENGTH)
      .default(CONTACT_FIELD_DEFAULT_MAX_LENGTH),
    /** The allowed values of a `select` field, and only of one. */
    options: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === 'select' && !field.options) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'A select field needs options.' });
    }
    if (field.type !== 'select' && field.options) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only a select field takes options.' });
    }
  });
export type ContactFieldDef = z.output<typeof ContactFieldDefSchema>;

/** A list's field schema: unique names, at most `CONTACT_MAX_FIELDS`. */
export const ContactFieldSchemaSchema = z
  .array(ContactFieldDefSchema)
  .max(CONTACT_MAX_FIELDS)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((field, i) => {
      if (seen.has(field.name)) {
        ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate field name "${field.name}".` });
      }
      seen.add(field.name);
    });
  });

/** A list as the operator routes return it. */
export interface ContactListDto {
  id: string;
  applicationId: string;
  key: string;
  name: string;
  description: string | null;
  kind: ContactListKind;
  fieldSchema: ContactFieldDef[];
  lawfulBasis: ContactLawfulBasis;
  consentText: string | null;
  /** 0 before any consent text was set. */
  consentVersion: number;
  publicCapture: boolean;
  blockDisposable: boolean;
  submissionRetentionDays: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  counts: ContactListCounts;
}

export interface ContactListCounts {
  subscribed: number;
  unsubscribed: number;
  submissions: number;
}

/** One entry of a list's consent history. */
export interface ContactListConsentVersionDto {
  version: number;
  text: string;
  createdBy: string | null;
  createdAt: string;
}

/** Total size of `fields` in one subscribe, serialised. */
export const CONTACT_FIELDS_MAX_BYTES = 8 * 1024;

/**
 * Body of `POST /api/v1/lists/:key/subscribe`, from a browser (publishable
 * key) or a server (secret key with `contacts:write`).
 *
 * @example
 * ```ts
 * ListSubscribeRequestSchema.parse({
 *   email: 'ada@example.com',
 *   consent: { granted: true, version: 1 },
 *   fields: { company: 'Analytical Engines' },
 * });
 * ```
 */
export const ListSubscribeRequestSchema = z
  .object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(1).max(120).optional(),
    /** Values for the list's `fieldSchema`, by field name. */
    fields: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** Required when the list's `lawfulBasis` is `consent`: the version `GET /lists/:key` returned. */
    consent: z.object({ granted: z.literal(true), version: z.number().int().min(0) }).strict().optional(),
    /** The page the form was on. Only the origin and path are stored. */
    sourceUrl: z.string().max(2048).optional(),
    /** Honeypot: render it hidden and leave it empty. A filled one stores nothing. */
    hp: z.string().max(500).optional(),
  })
  .strict();
export type ListSubscribeRequest = z.input<typeof ListSubscribeRequestSchema>;

/** What a publishable-key subscribe, or a secret-key one naming the visitor, always answers. */
export interface ListSubscribeReceived {
  status: 'received';
}

/**
 * What a secret-key subscribe with no visitor address answers.
 *
 * - `subscribed`: added, or added back with consent.
 * - `already_subscribed`: nothing changed.
 * - `previously_unsubscribed`: the person left this list; send `consent` to add them back.
 * - `suppressed`: the address bounced, complained or was blocked; nothing was stored.
 * - `ignored`: the honeypot was filled; nothing was stored.
 */
export interface ListSubscribeOutcome {
  status: 'subscribed' | 'already_subscribed' | 'previously_unsubscribed' | 'suppressed' | 'ignored';
  contactId: string | null;
}

export const LIST_MEMBER_STATUSES = ['subscribed', 'unsubscribed'] as const;
export type ListMemberStatus = (typeof LIST_MEMBER_STATUSES)[number];

/** One person on a list, as `GET /api/v1/lists/:key/members` returns them. */
export interface ListMemberDto {
  contactId: string;
  email: string;
  name: string | null;
  status: ListMemberStatus;
  /** `publishable` (a browser), `secret` (your server) or `operator`. */
  source: string;
  consentVersion: number | null;
  consentAt: string | null;
  /** When they first joined. */
  subscribedAt: string;
  unsubscribedAt: string | null;
  /** Moves on every change; pass the last one you saw as `updatedSince` to sync. */
  updatedAt: string;
}

/** A member as the operator routes return it: the consent proof, and whether the address is also an end user. */
export interface ContactListMemberRowDto {
  memberId: string;
  contactId: string;
  email: string;
  name: string | null;
  status: ListMemberStatus;
  source: string;
  consentVersion: number | null;
  consentAt: string | null;
  consentIpPrefix: string | null;
  sourceUrl: string | null;
  subscribedAt: string;
  unsubscribedAt: string | null;
  /** The end user with this address in the same Application, when there is one. */
  endUserId: string | null;
}

/** A stored submission as the operator routes return it. */
export interface ContactSubmissionRowDto {
  id: string;
  contactId: string;
  email: string;
  fields: Record<string, string | number | boolean>;
  createdAt: string;
}

/** One list as `GET /api/v1/lists` returns it to a server: counts, never addresses. */
export interface ContactListSummaryDto {
  key: string;
  name: string;
  kind: ContactListKind;
  publicCapture: boolean;
  archived: boolean;
  subscribed: number;
  unsubscribed: number;
}

/** A page of members. Pass `nextCursor` back as `cursor`; null means this was the last page. */
export interface ListMembersPage {
  items: ListMemberDto[];
  nextCursor: string | null;
}

/** A list as a browser or server sees it before subscribing: `GET /api/v1/lists/:key`. */
export interface ContactListPublicDto {
  key: string;
  name: string;
  kind: ContactListKind;
  fieldSchema: ContactFieldDef[];
  consent: {
    text: string | null;
    /** Send this back as `consent.version`. */
    version: number;
    lawfulBasis: ContactLawfulBasis;
  };
}
