/**
 * Custom transactional email templates: registered in the panel or the
 * operator API, then sent by key with `POST /api/v1/email/send`.
 * Error codes: docs/errors.md, "Email: custom templates".
 */

import { z } from 'zod';

/** A template key: lowercase, starts with a letter, 3 to 64 characters. */
export const CUSTOM_EMAIL_TEMPLATE_KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** A variable name as it appears in `{{name}}`. */
export const CUSTOM_EMAIL_VARIABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const CUSTOM_EMAIL_CATEGORIES = ['critical', 'notification'] as const;
export type CustomEmailCategory = (typeof CUSTOM_EMAIL_CATEGORIES)[number];

export const CUSTOM_EMAIL_VARIABLE_TYPES = ['string', 'number', 'url', 'date'] as const;
export type CustomEmailVariableType = (typeof CUSTOM_EMAIL_VARIABLE_TYPES)[number];

export const CUSTOM_EMAIL_DEFAULT_MAX_LENGTH = 256;
export const CUSTOM_EMAIL_MAX_VARIABLES = 50;
export const CUSTOM_EMAIL_MAX_LINK_DOMAINS = 20;

/** One declared variable of a custom template. */
export const CustomEmailVariableDefSchema = z
  .object({
    name: z.string().regex(CUSTOM_EMAIL_VARIABLE_NAME_RE),
    type: z.enum(CUSTOM_EMAIL_VARIABLE_TYPES),
    required: z.boolean().default(false),
    maxLength: z.number().int().min(1).max(2048).default(CUSTOM_EMAIL_DEFAULT_MAX_LENGTH),
    /** Used by the panel preview and the test send. Never used by a real send. */
    sample: z.string().max(2048).optional(),
  })
  .strict();
export type CustomEmailVariableDef = z.output<typeof CustomEmailVariableDefSchema>;

/**
 * Body of `POST /api/v1/email/send`. Strict: a subject, HTML body or From in
 * the call is refused, because everything but the variable values must have
 * been registered and published in advance.
 *
 * @example
 * ```ts
 * EmailSendRequestSchema.parse({
 *   template: 'order_shipped',
 *   to: 'buyer@example.com',
 *   variables: { orderNumber: 'A-1042' },
 *   idempotencyKey: 'order-A-1042-shipped',
 * });
 * ```
 */
export const EmailSendRequestSchema = z
  .object({
    template: z.string().regex(CUSTOM_EMAIL_TEMPLATE_KEY_RE),
    to: z.string().email().max(254),
    /** Values for the template's declared variables. Checked against its schema. */
    variables: z.record(z.union([z.string(), z.number()])).default({}),
    /** Send this published version instead of the latest. */
    version: z.number().int().min(1).optional(),
    /** A repeat with the same key returns the first result and sends nothing. */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type EmailSendRequest = z.input<typeof EmailSendRequestSchema>;

/** `data` of a `202` from `POST /api/v1/email/send`. */
export interface EmailSendResult {
  /** The email log row id. */
  id: string;
  /** `suppressed`: the address is on the suppression list or the Application's email is off. Nothing was sent. */
  status: 'sent' | 'suppressed';
  template: string;
  version: number;
  /** The provider's message id, when it returned one. */
  messageId?: string;
}

/** A custom template as the operator routes return it. */
export interface CustomEmailTemplateDto {
  id: string;
  applicationId: string;
  key: string;
  name: string;
  category: CustomEmailCategory;
  fromName: string | null;
  subject: string;
  designJson: unknown;
  bodyHtml: string;
  bodyText: string | null;
  variableSchema: CustomEmailVariableDef[];
  linkDomains: string[];
  status: 'draft' | 'published';
  /** Latest published version, 0 before the first publish. */
  version: number;
  publishedAt: string | null;
  /** True when the draft was edited after the latest publish. */
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
}
