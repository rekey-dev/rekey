/**
 * Public custom-email surface.
 *
 *   POST /api/v1/email/send          secret key with `email:send`
 *   GET  /api/v1/email/unsubscribe   confirm page (never unsubscribes)
 *   POST /api/v1/email/unsubscribe   RFC 8058 one-click, and the confirm page's button
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { EmailSendRequestSchema } from '@rekey.dev/shared-types';
import { RekeyError } from '../../../lib/error.js';
import { requireApiKey, requireScope } from '../../../middleware/api-key-auth.js';
import { errs, ok, raw } from '../../../lib/openapi.js';
import { sendCustomEmail } from './custom-send.service.js';
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
      enum: ['sent', 'suppressed'],
      description:
        '`suppressed`: the address is on the suppression list, or all email is switched off for ' +
        'this Application. Nothing was sent and the attempt is logged.',
    },
    template: { type: 'string' },
    version: { type: 'integer', description: 'The published version that was rendered.' },
    messageId: { type: 'string', description: "The provider's message id, when it returned one." },
  },
  required: ['id', 'status', 'template', 'version'],
} as const;

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
          '`idempotencyKey` (or an `Idempotency-Key` header) makes a retry safe: a repeat returns ' +
          'the first result and sends nothing, including a repeat of a failed attempt. Caps: ' +
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
            to: { type: 'string', format: 'email', maxLength: 254 },
            variables: {
              type: 'object',
              additionalProperties: true,
              description: 'String or number values for the template variables.',
            },
            version: { type: 'integer', minimum: 1 },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
        response: {
          202: ok(SEND_RESULT, 'Sent, or deliberately not sent (`status: "suppressed"`).'),
          ...errs({
            400:
              'VALIDATION_ERROR: the body does not match, or carries a field the route does not take; ' +
              'or EMAIL_VARIABLES_INVALID: a variable failed its declared rule (see `details.issues`).',
            401:
              'API_KEY_MISSING / API_KEY_INVALID: no key, or not a valid secret key for an Application.',
            403:
              'API_KEY_SCOPE_INSUFFICIENT: the key was not minted with `email:send`; or ' +
              "EMAIL_TRANSPORT_NOT_CUSTOM: the Application has no Resend or SMTP provider of its own; or " +
              'EMAIL_RECIPIENT_NOT_END_USER: the Application only mails its own end users; or ' +
              "IP_NOT_ALLOWED: caller IP outside the key's allowlist.",
            404: 'EMAIL_TEMPLATE_NOT_FOUND: no template with that key, or no such published version.',
            409:
              'EMAIL_TEMPLATE_NOT_PUBLISHED: the template has never been published; or ' +
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
      const result = await sendCustomEmail(req.application!, {
        template: body.template,
        to: body.to,
        variables: body.variables,
        version: body.version,
        idempotencyKey: body.idempotencyKey ?? headerKey,
      });
      return reply.status(202).send({ success: true, data: result });
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

const TokenQuery = z.object({ token: z.string().min(1).max(2048) });

/** Says exactly which mail stops, and that account mail does not. */
function scopeSentence(name: string): string {
  return (
    `Notification emails from ${escapeHtml(name)} stop. Emails you need to use your account, ` +
    'such as password resets, sign-in links and address confirmations, keep arriving.'
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
          'Linked from the `List-Unsubscribe` header of `notification` custom email. Shows one button ' +
          'that posts back to this URL. Opening the page changes nothing, because mail scanners follow links.',
        security: [],
        querystring: { type: 'object', properties: { token: { type: 'string' } } },
        response: htmlResponses,
      },
    },
    async (req, reply) => {
      const parsed = TokenQuery.safeParse(req.query);
      const view = parsed.success ? await describeUnsubscribe(parsed.data.token) : null;
      if (!parsed.success || !view) return page(reply, 200, 'Unsubscribe', INVALID_LINK);
      const action = `?token=${encodeURIComponent(parsed.data.token)}`;
      return page(
        reply,
        200,
        'Unsubscribe',
        `<h1>Unsubscribe ${escapeHtml(view.address)}?</h1><p>${scopeSentence(view.applicationName)}</p>` +
          `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="List-Unsubscribe" value="One-Click">` +
          `<button type="submit">Unsubscribe</button></form>`,
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
          "Adds the address named by `token` to the Application's suppression list with reason " +
          '`unsubscribe` and category `notification`: notification custom mail stops, while built-in ' +
          'mail (password reset, verification, magic link) and critical custom mail keep arriving. ' +
          'An address already on the list keeps its existing entry. ' +
          'Idempotent. The body (`List-Unsubscribe=One-Click`) is accepted and ignored.',
        security: [],
        querystring: { type: 'object', properties: { token: { type: 'string' } } },
        response: htmlResponses,
      },
    },
    async (req, reply) => {
      const parsed = TokenQuery.safeParse(req.query);
      const view = parsed.success ? await unsubscribe(parsed.data.token) : null;
      if (!view) return page(reply, 200, 'Unsubscribe', INVALID_LINK);
      return page(
        reply,
        200,
        'Unsubscribed',
        `<h1>Unsubscribed</h1><p>${escapeHtml(view.address)} is unsubscribed. ${scopeSentence(view.applicationName)}</p>`,
      );
    },
  );
}
