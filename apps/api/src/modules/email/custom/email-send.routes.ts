/**
 * Public custom-email surface.
 *
 *   POST /api/v1/email/send          secret key with `email:send`
 *   GET  /api/v1/email/sends/:id     secret key with `email:send`
 *   GET  /api/v1/email/sends?idempotencyKey=
 *   DELETE /api/v1/email/sends/:id   cancel a scheduled send
 *   GET  /api/v1/email/unsubscribe   confirm page (never unsubscribes)
 *   POST /api/v1/email/unsubscribe   RFC 8058 one-click, and the confirm page's button
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { EMAIL_SEND_MAX_SCHEDULE_DAYS, EmailSendRequestSchema } from '@rekey.dev/shared-types';
import { RekeyError } from '../../../lib/error.js';
import { requireApiKey, requireScope } from '../../../middleware/api-key-auth.js';
import { errs, ok, raw, ref } from '../../../lib/openapi.js';
import { emailService, type EmailLogRow } from '../email.service.js';
import { dryRunCustomEmail, sendCustomEmail } from './custom-send.service.js';
import { sendNotFound } from './errors.js';
import { cancelScheduledSend } from './scheduled-sends.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `sendAt` in the future and no more than the scheduling window ahead. */
function scheduleTime(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  const now = Date.now();
  if (at.getTime() <= now || at.getTime() > now + EMAIL_SEND_MAX_SCHEDULE_DAYS * DAY_MS) {
    throw new RekeyError({
      statusCode: 400,
      code: 'EMAIL_SEND_AT_INVALID',
      message: `sendAt must be in the future and at most ${EMAIL_SEND_MAX_SCHEDULE_DAYS} days ahead.`,
      fix: 'Pass an ISO 8601 instant with an offset, such as 2026-11-01T09:00:00Z, or leave sendAt out to send now.',
    });
  }
  return at;
}
import { describeUnsubscribe, unsubscribe } from './unsubscribe.service.js';

const SendBody = EmailSendRequestSchema.extend({
  // Typed per variable against the template's schema, so a wrong type is an
  // EMAIL_VARIABLES_INVALID naming the variable, not a generic 400.
  variables: z.record(z.unknown()).default({}),
});

const SEND_RESULT = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The email log row id.' },
    status: {
      type: 'string',
      enum: ['sent', 'suppressed', 'scheduled', 'canceled'],
      description:
        '`suppressed`: the address is on the suppression list, or all email is switched off for ' +
        'this Application. Nothing was sent and the attempt is logged. `scheduled`: it goes at ' +
        '`sendAt`. `canceled`: a replay of a scheduled send that was canceled.',
    },
    sendAt: { type: 'string', format: 'date-time', description: 'When a scheduled send is due.' },
    template: { type: 'string' },
    version: { type: 'integer', description: 'The published version that was rendered.' },
    messageId: { type: 'string', description: "The provider's message id, when it returned one." },
  },
  required: ['id', 'status', 'template', 'version'],
} as const;

const DRY_RUN_RESULT = {
  type: 'object',
  properties: {
    dryRun: { type: 'boolean', enum: [true] },
    status: {
      type: 'string',
      enum: ['would_send', 'suppressed'],
      description: '`suppressed`: a real send would be logged as suppressed and nothing would go out.',
    },
    template: { type: 'string' },
    version: { type: 'integer' },
    subject: { type: 'string' },
    html: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['dryRun', 'status', 'template', 'version', 'subject', 'html', 'text'],
} as const;

const SEND_LOOKUP_ERRORS = {
  401: 'API_KEY_MISSING / API_KEY_INVALID: no key, or not a valid secret key for an Application.',
  403: 'API_KEY_SCOPE_INSUFFICIENT: the key was not minted with `email:send`; or IP_NOT_ALLOWED.',
  404: 'EMAIL_SEND_NOT_FOUND: no send of this Application matches, or its log row passed `LOG_RETENTION_DAYS`.',
} as const;

const RECIPIENT_BY_ID = {
  type: 'object',
  required: ['endUserId'],
  properties: { endUserId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

function shapeSend(row: EmailLogRow): Omit<EmailLogRow, 'createdAt' | 'sendAt'> & { createdAt: string; sendAt: string | null } {
  return { ...row, sendAt: row.sendAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

export async function emailSendRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);

  app.post(
    '/send',
    {
      onRequest: requireScope('email:send'),
      schema: {
        tags: ['Public · Email'],
        summary: 'Send a published custom email template to one recipient',
        description:
          'Renders a custom template registered and published in the panel (or through ' +
          '`/api/v1/tenant/applications/:id/custom-email-templates`) with `variables`, and sends it ' +
          "through the Application's own Resend or SMTP provider. The shared pool is never used.\n\n" +
          'Requires a secret key minted with the elevated **`email:send`** scope named; `*` does not ' +
          'include it. The body is strict: a subject, HTML or From address in the call is refused.\n\n' +
          'Variables are checked against the template: undeclared names are refused, `required` is ' +
          'enforced, `url` values must be https and on the template link domains, `date` is ISO ' +
          '8601, `number` is a finite JSON number.\n\n' +
          '`to` is an address, or `{ "endUserId": "..." }` to let Rekey look the address up. By id, an ' +
          'unknown or erased end user is EMAIL_RECIPIENT_NOT_FOUND, a banned one EMAIL_RECIPIENT_BANNED and ' +
          'one with an unverified address EMAIL_RECIPIENT_UNVERIFIED, and nothing is sent or logged.\n\n' +
          '`notification` mail carries a one-click unsubscribe for its template topic; a recipient who left ' +
          'that topic, or every notification email, is answered `suppressed`.\n\n' +
          '`dryRun: true` runs every check above, reports whether the send would be suppressed and ' +
          'returns the render with `200`. It sends nothing, writes no log row, counts against no cap and ' +
          'does not use `idempotencyKey`.\n\n' +
          '`idempotencyKey` (or an `Idempotency-Key` header) makes a retry safe: a repeat returns ' +
          'the first result and sends nothing, including a repeat of a failed attempt. A key is ' +
          'remembered as long as its log row: forever unless the deployment sets `LOG_RETENTION_DAYS`. ' +
          'Read a send back with `GET /api/v1/email/sends/:id` or `?idempotencyKey=`.\n\n' +
          '`sendAt` schedules the send for later, up to 30 days ahead: every check above runs now, the ' +
          'answer is `status: "scheduled"`, and at `sendAt` (within about a quarter of a minute) the send ' +
          'runs as if made then, so a recipient who unsubscribed, was erased, banned or suppressed in the ' +
          'meantime is logged `suppressed`. Cancel it with `DELETE /api/v1/email/sends/:id` until it fires. ' +
          'Caps count when it fires. Caps: ' +
          'per workspace, `EMAIL_SEND_DAILY_CAP` per UTC day (default 1000) and ' +
          '`EMAIL_SEND_RECIPIENT_HOURLY_CAP` per recipient per hour (default 10), unless the workspace ' +
          'limits set other numbers.',
        security: [{ apiKey: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 200 } },
        },
        body: {
          type: 'object',
          required: ['template', 'to'],
          // Any other field is refused by the handler. Not `additionalProperties:
          // false` here: the validator would silently strip the field instead.
          properties: {
            template: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' },
            to: { oneOf: [{ type: 'string', format: 'email', maxLength: 254 }, RECIPIENT_BY_ID] },
            variables: {
              type: 'object',
              additionalProperties: true,
              description: 'String or number values for the template variables.',
            },
            version: { type: 'integer', minimum: 1 },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
            dryRun: { type: 'boolean', description: 'Check and render only. Answers 200.' },
            sendAt: {
              type: 'string',
              format: 'date-time',
              description: `Send at this instant instead of now, at most ${EMAIL_SEND_MAX_SCHEDULE_DAYS} days ahead.`,
            },
          },
        },
        response: {
          200: ok(DRY_RUN_RESULT, 'A dry run: what a send would do, and the render. Nothing was sent.'),
          202: ok(SEND_RESULT, 'Sent, or deliberately not sent (`status: "suppressed"`).'),
          ...errs({
            400:
              'VALIDATION_ERROR: the body does not match, or carries a field the route does not take; ' +
              'or EMAIL_VARIABLES_INVALID: a variable failed its declared rule (see `details.issues`); or ' +
              'EMAIL_SEND_AT_INVALID: `sendAt` is in the past or more than 30 days ahead.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID: no key, or not a valid secret key for an Application.',
            403:
              'API_KEY_SCOPE_INSUFFICIENT: the key was not minted with `email:send`; or ' +
              "EMAIL_TRANSPORT_NOT_CUSTOM: the Application has no Resend or SMTP provider of its own; or " +
              'EMAIL_RECIPIENT_NOT_END_USER: the Application only mails its own end users; or ' +
              "IP_NOT_ALLOWED: caller IP outside the key's allowlist.",
            404:
              'EMAIL_TEMPLATE_NOT_FOUND: no template with that key, or no such published version; or ' +
              'EMAIL_RECIPIENT_NOT_FOUND: `to.endUserId` names no live end user of this Application.',
            409:
              'EMAIL_TEMPLATE_NOT_PUBLISHED: the template has never been published; or ' +
              'EMAIL_RECIPIENT_BANNED / EMAIL_RECIPIENT_UNVERIFIED: the end user named by id is banned, or ' +
              'has not verified their address; or ' +
              'EMAIL_SENDER_DOMAIN_MISMATCH: no From address, or its domain changed since publish; or ' +
              'EMAIL_IDEMPOTENCY_KEY_REUSED: the key was used for a different send; or ' +
              'EMAIL_SEND_IN_FLIGHT: the first send with this key has not finished; or ' +
              'EMAIL_SEND_OUTCOME_UNKNOWN: the first send with this key never recorded an outcome.',
            429: 'EMAIL_RATE_LIMITED: a send cap is reached; or RATE_LIMITED. Honour Retry-After.',
            502: "EMAIL_DELIVERY_FAILED: the Application's provider did not accept the message.",
            503: 'DEPENDENCY_UNAVAILABLE: the cap counters are unreachable, so nothing was sent.',
          }),
        },
      },
    },
    async (req, reply) => {
      const body = SendBody.parse(req.body);
      const header = req.headers['idempotency-key'];
      const headerKey = typeof header === 'string' && header.length > 0 ? header : undefined;
      if (headerKey !== undefined && body.idempotencyKey !== undefined && headerKey !== body.idempotencyKey) {
        throw new RekeyError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'The Idempotency-Key header and the body `idempotencyKey` differ.',
          fix: 'Send the key once, in either place, or send the same value in both.',
        });
      }
      if (headerKey !== undefined && headerKey.length > 200) {
        throw new RekeyError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'The Idempotency-Key header exceeds 200 characters.',
          fix: 'Use a key of 1 to 200 characters, such as a UUID.',
        });
      }
      const request = {
        template: body.template,
        to: body.to,
        variables: body.variables,
        version: body.version,
        idempotencyKey: body.idempotencyKey ?? headerKey,
        sendAt: scheduleTime(body.sendAt),
      };
      if (body.dryRun === true) {
        return reply.status(200).send({ success: true, data: await dryRunCustomEmail(req.application!, request) });
      }
      return reply.status(202).send({ success: true, data: await sendCustomEmail(req.application!, request) });
    },
  );

  app.get(
    '/sends/:id',
    {
      onRequest: requireScope('email:send'),
      schema: {
        tags: ['Public · Email'],
        summary: 'Read one send of this Application by its log row id',
        description:
          'The `id` a send returned. Use it to find out what happened to a send, for example after ' +
          'EMAIL_SEND_OUTCOME_UNKNOWN. Requires a secret key with `email:send`.',
        security: [{ apiKey: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 200: ok(ref('EmailLog'), 'The send-log row.'), ...errs(SEND_LOOKUP_ERRORS) },
      },
    },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      const row = await emailService.findAppLog(req.application!.id, { id });
      if (!row) throw sendNotFound();
      return { success: true, data: shapeSend(row) };
    },
  );

  app.get(
    '/sends',
    {
      onRequest: requireScope('email:send'),
      schema: {
        tags: ['Public · Email'],
        summary: 'Read one send of this Application by the idempotency key it was sent with',
        description:
          'Answers whether a keyed send went out before you retry it with a new key. Requires a secret ' +
          'key with `email:send`.',
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          required: ['idempotencyKey'],
          properties: { idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 } },
        },
        response: { 200: ok(ref('EmailLog'), 'The send-log row.'), ...errs(SEND_LOOKUP_ERRORS) },
      },
    },
    async (req) => {
      const { idempotencyKey } = z.object({ idempotencyKey: z.string().min(1).max(200) }).parse(req.query);
      const row = await emailService.findAppLog(req.application!.id, { idempotencyKey });
      if (!row) throw sendNotFound();
      return { success: true, data: shapeSend(row) };
    },
  );

  app.delete(
    '/sends/:id',
    {
      onRequest: requireScope('email:send'),
      schema: {
        tags: ['Public · Email'],
        summary: 'Cancel a scheduled send before it fires',
        description:
          'Only a send made with `sendAt` that has not fired yet can be canceled; it is logged `canceled` and a ' +
          'replay of its idempotency key answers `canceled`. Requires a secret key with `email:send`.',
        security: [{ apiKey: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(ref('EmailLog'), 'The canceled send.'),
          ...errs({
            ...SEND_LOOKUP_ERRORS,
            409: 'EMAIL_SEND_NOT_SCHEDULED: the send already fired, was canceled, or was never scheduled.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
      await cancelScheduledSend(req.application!.id, id);
      const row = await emailService.findAppLog(req.application!.id, { id });
      return { success: true, data: shapeSend(row!) };
    },
  );
}

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]!);

function page(reply: FastifyReply, status: number, title: string, body: string): FastifyReply {
  return reply
    .status(status)
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Robots-Tag', 'noindex')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title>` +
        `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}` +
        `button{font:inherit;padding:.5rem 1rem;cursor:pointer}</style></head>` +
        `<body>${body}</body></html>`,
    );
}

const INVALID_LINK =
  '<h1>This link does not work</h1><p>The unsubscribe link is incomplete or was not issued by this service. Open it again from the email itself.</p>';

const TokenQuery = z.object({
  token: z.string().min(1).max(2048),
  scope: z.enum(['topic', 'all']).default('topic'),
});

const ACCOUNT_MAIL_KEEPS_ARRIVING =
  'Emails you need to use your account, such as password resets, sign-in links and address confirmations, keep arriving.';

/** Says exactly which mail stops, and that account mail does not. */
function scopeSentence(name: string, topic: string | undefined): string {
  const what =
    topic === undefined
      ? `Notification emails from ${escapeHtml(name)} stop.`
      : `Emails about ${escapeHtml(topic.replaceAll('_', ' '))} from ${escapeHtml(name)} stop.`;
  return `${what} ${ACCOUNT_MAIL_KEEPS_ARRIVING}`;
}

function unsubscribeForm(token: string, scope: 'topic' | 'all', label: string): string {
  const action = `?token=${encodeURIComponent(token)}${scope === 'all' ? '&scope=all' : ''}`;
  return (
    `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click">` +
    `<button type="submit">${escapeHtml(label)}</button></form>`
  );
}

export async function emailUnsubscribeRoutes(app: FastifyInstance): Promise<void> {
  // RFC 8058 allows the one-click body as multipart/form-data. The body is
  // ignored (the token is in the URL), so it is read and discarded.
  app.addContentTypeParser('multipart/form-data', { parseAs: 'string', bodyLimit: 8192 }, (_req, _body, done) =>
    done(null, {}),
  );

  const htmlResponses = {
    200: raw('A short HTML page.', 'text/html'),
    ...errs({ 429: 'RATE_LIMITED: too many requests. Honour Retry-After.' }),
  };

  app.get(
    '/unsubscribe',
    {
      schema: {
        tags: ['Public · Email'],
        summary: 'Unsubscribe confirm page for custom notification email',
        description:
          'Linked from the `List-Unsubscribe` header of `notification` custom email. Shows a button ' +
          "that posts back to this URL to leave the email's topic, and a second one to leave every " +
          'notification email. Opening the page changes nothing, because mail scanners follow links.',
        security: [],
        querystring: { type: 'object', properties: { token: { type: 'string' } } },
        response: htmlResponses,
      },
    },
    async (req, reply) => {
      const parsed = TokenQuery.safeParse(req.query);
      const view = parsed.success ? await describeUnsubscribe(parsed.data.token) : null;
      if (!parsed.success || !view) return page(reply, 200, 'Unsubscribe', INVALID_LINK);
      const { token } = parsed.data;
      const leaveAll =
        view.topic === undefined
          ? ''
          : `<p>${scopeSentence(view.applicationName, undefined)}</p>` +
            unsubscribeForm(token, 'all', 'Unsubscribe from all notification emails');
      return page(
        reply,
        200,
        'Unsubscribe',
        `<h1>Unsubscribe ${escapeHtml(view.address)}?</h1><p>${scopeSentence(view.applicationName, view.topic)}</p>` +
          unsubscribeForm(token, 'topic', 'Unsubscribe') +
          leaveAll,
      );
    },
  );

  app.post(
    '/unsubscribe',
    {
      config: { acceptsForm: true, acceptsMultipartForm: true },
      schema: {
        tags: ['Public · Email'],
        summary: 'One-click unsubscribe (RFC 8058)',
        description:
          'Leaves the topic named by `token`: notification custom mail on that topic stops, and other ' +
          'topics keep arriving. With `scope=all`, or a token issued before topics existed, the address ' +
          "goes on the Application's suppression list with reason `unsubscribe` and category " +
          '`notification`, which stops every notification email. Built-in mail (password reset, ' +
          'verification, magic link) and critical custom mail keep arriving either way. An address ' +
          'already on the list keeps its existing entry. Sends `email.unsubscribed` when something ' +
          'changed. Idempotent. The body (`List-Unsubscribe=One-Click`) is accepted and ignored.',
        security: [],
        querystring: {
          type: 'object',
          properties: { token: { type: 'string' }, scope: { type: 'string', description: '`topic` (default) or `all`.' } },
        },
        response: htmlResponses,
      },
    },
    async (req, reply) => {
      const parsed = TokenQuery.safeParse(req.query);
      const view = parsed.success ? await unsubscribe(parsed.data.token, parsed.data.scope) : null;
      if (!parsed.success || !view) return page(reply, 200, 'Unsubscribe', INVALID_LINK);
      const topic = parsed.data.scope === 'topic' ? view.topic : undefined;
      return page(
        reply,
        200,
        'Unsubscribed',
        `<h1>Unsubscribed</h1><p>${escapeHtml(view.address)} is unsubscribed. ${scopeSentence(view.applicationName, topic)}</p>`,
      );
    },
  );
}
