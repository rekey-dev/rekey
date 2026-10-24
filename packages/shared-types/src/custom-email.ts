/**
 * Custom transactional email templates: registered in the panel or the
 * operator API, then sent by key with `POST /api/v1/email/send`.
 * Error codes: docs/errors.md, "Email: custom templates".
 */

import { z } from 'zod';

/** A template key: lowercase, starts with a letter, 3 to 64 characters. */
export const CUSTOM_EMAIL_TEMPLATE_KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** A notification topic: the same shape as a template key, which is its default. */
export const CUSTOM_EMAIL_TOPIC_RE = CUSTOM_EMAIL_TEMPLATE_KEY_RE;

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
 * A recipient named by end-user id instead of address. Rekey resolves the
 * address, and refuses an unknown, erased, banned or unverified end user.
 */
export const EmailRecipientByIdSchema = z.object({ endUserId: z.string().min(1).max(64) }).strict();

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
    to: z.union([z.string().email().max(254), EmailRecipientByIdSchema]),
    /** Values for the template's declared variables. Checked against its schema. */
    variables: z.record(z.union([z.string(), z.number()])).default({}),
    /** Send this published version instead of the latest. */
    version: z.number().int().min(1).optional(),
    /** A repeat with the same key returns the first result and sends nothing. */
    idempotencyKey: z.string().min(1).max(200).optional(),
    /** Check and render without sending: no log row, no caps, no idempotency key used. */
    dryRun: z.boolean().optional(),
    /** Send at this instant instead of now: ISO 8601, in the future, at most 30 days ahead. */
    sendAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type EmailSendRequest = z.input<typeof EmailSendRequestSchema>;

/** `data` of a `202` from `POST /api/v1/email/send`. */
export interface EmailSendResult {
  /** The email log row id. */
  id: string;
  /**
   * `suppressed`: the address is on the suppression list or the Application's email is off. Nothing was sent.
   * `scheduled`: it goes at `sendAt`; `canceled`: it was scheduled and then canceled.
   */
  status: 'sent' | 'suppressed' | 'scheduled' | 'canceled';
  template: string;
  version: number;
  /** The provider's message id, when it returned one. */
  messageId?: string;
  /** When a scheduled send is due. */
  sendAt?: string;
}

/** How far ahead a send may be scheduled. */
export const EMAIL_SEND_MAX_SCHEDULE_DAYS = 30;

/** `data` of a `200` from `POST /api/v1/email/send` with `dryRun: true`. */
export interface EmailDryRunResult {
  dryRun: true;
  /** `suppressed`: a real send would be logged as suppressed and nothing would go out. */
  status: 'would_send' | 'suppressed';
  template: string;
  version: number;
  subject: string;
  html: string;
  text: string;
}

/** `data` of `GET /api/v1/email/sends/:id` and `GET /api/v1/email/sends?idempotencyKey=`: one send-log row. */
export interface EmailSendRecord {
  id: string;
  applicationId: string | null;
  toAddress: string;
  subject: string;
  eventKey: string | null;
  via: string;
  /** `sent`, `suppressed`, `error`, `no_transport`, `pending` (in flight) or `unknown` (never recorded an outcome). */
  status: string;
  messageId: string | null;
  error: string | null;
  customTemplateKey: string | null;
  customTemplateVersion: number | null;
  /** When a scheduled send is due. */
  sendAt: string | null;
  createdAt: string;
}

/** Whether one recipient receives notification mail, per topic and as a whole. */
export type EmailTopicState = 'subscribed' | 'unsubscribed';

/** `data` of `GET` and `PATCH /api/v1/users/:id/email-preferences`. */
export interface EmailPreferences {
  /** `unsubscribed`: they left every notification email, so every topic reads unsubscribed. */
  allNotifications: EmailTopicState;
  /** Every topic ever published on a notification template of this Application. */
  topics: Record<string, EmailTopicState>;
}

/** A custom template as the operator routes return it. */
export interface CustomEmailTemplateDto {
  id: string;
  applicationId: string;
  key: string;
  name: string;
  category: CustomEmailCategory;
  /** What a recipient unsubscribes from. The key unless set. */
  topic: string;
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
