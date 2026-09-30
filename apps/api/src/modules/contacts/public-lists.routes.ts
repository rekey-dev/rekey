/**
 * Public list surface, for a browser (publishable key) or the Application's
 * own server (secret key with `contacts:write`):
 *
 *   GET  /api/v1/lists/:key             the list's form: fields and consent text
 *   POST /api/v1/lists/:key/subscribe   add someone, and store what they typed
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTACT_FIELDS_MAX_BYTES, ListSubscribeRequestSchema } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import { errs, ok } from '../../lib/openapi.js';
import { attributedAuthClientIp } from '../../lib/rate-limit.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { getPublicList, isAuthoritative, noteQuotaRefusal, subscribe, type CaptureCaller } from './capture.service.js';

const KeyParam = z.object({ key: z.string().min(1).max(64) });

const SECURITY = [{ apiKey: [] }, { publishableKey: [] }];
const TAGS = ['Public · Lists'];

const AUTH_ERRORS = {
  401: 'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID: no key, or not one of this deployment.',
  403:
    'API_KEY_SCOPE_INSUFFICIENT: a secret key without `contacts:write`; or ORIGIN_NOT_ALLOWED: a ' +
    "publishable request from an origin outside the Application's Access list; or IP_NOT_ALLOWED; or " +
    'APPLICATION_DISABLED.',
} as const;

const NOT_FOUND =
  'LIST_NOT_FOUND: no such list, or it is archived. A secret key gets `details.available`, the live ' +
  'keys. A publishable key gets the same code for a list whose public capture is off, or whose ' +
  'Application has no browser origins.';

const PUBLIC_LIST = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['newsletter', 'waitlist', 'contact_form', 'generic'] },
    fieldSchema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string' },
          required: { type: 'boolean' },
          maxLength: { type: 'integer' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'label', 'type', 'required', 'maxLength'],
      },
    },
    consent: {
      type: 'object',
      properties: {
        text: { type: 'string', nullable: true, description: 'Show this next to the checkbox.' },
        version: { type: 'integer', description: 'Send it back as `consent.version`.' },
        lawfulBasis: { type: 'string', enum: ['consent', 'legitimate_interest', 'contract'] },
      },
      required: ['text', 'version', 'lawfulBasis'],
    },
  },
  required: ['key', 'name', 'kind', 'fieldSchema', 'consent'],
} as const;

const SUBSCRIBE_RESULT = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['received', 'subscribed', 'already_subscribed', 'previously_unsubscribed', 'suppressed', 'ignored'],
      description:
        'A publishable key, or a secret key naming the visitor, always gets `received`. A secret key ' +
        'with no visitor address gets what happened: `subscribed` ' +
        '(added, or added back with consent), `already_subscribed`, `previously_unsubscribed` (the ' +
        'person left; only a secret-key call with `consent` adds them back), `suppressed` (the address ' +
        'bounced, complained or was blocked; nothing stored), `ignored` (the honeypot was filled).',
    },
    contactId: { type: 'string', nullable: true, description: 'Secret key only.' },
  },
  required: ['status'],
} as const;

/** Sent by the SDK helpers that relay a browser form, so a missing visitor address never makes the relay authoritative. */
export const RELAY_HEADER = 'x-rekey-relay';

function callerOf(req: FastifyRequest): CaptureCaller {
  return {
    application: req.application!,
    trusted: req.authKind === 'secret',
    relayed: req.headers[RELAY_HEADER] === 'browser',
    visitorIp: attributedAuthClientIp(req),
  };
}

export async function publicListsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('contacts:write'));

  app.get(
    '/:key',
    {
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "A list's form: its fields and the consent text to show",
        description:
          'Call it before rendering a form, and send the returned `consent.version` back with the ' +
          'subscribe. A publishable key reaches only a list with Public capture on, on an ' +
          'Application with at least one browser origin in Access.',
        params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        response: { 200: ok(PUBLIC_LIST, 'The list.'), ...errs({ ...AUTH_ERRORS, 404: NOT_FOUND }) },
      },
    },
    async (req) => {
      const { key } = KeyParam.parse(req.params);
      return { success: true, data: await getPublicList(callerOf(req), key) };
    },
  );

  app.post(
    '/:key/subscribe',
    {
      bodyLimit: CONTACT_FIELDS_MAX_BYTES * 2,
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Add someone to a list',
        description:
          'One route for both key types. A **publishable** key, and a **secret** key that relays a ' +
          'browser (it names the visitor in `X-Rekey-Client-Ip`, or sends `X-Rekey-Relay: browser`), get `202 {status:"received"}` ' +
          'whatever happened, so the route cannot be used to learn who is on a list; neither can add ' +
          'back someone who unsubscribed or rename a contact. A **secret** key speaking for itself ' +
          '(`contacts:write`, in `*`, no visitor address, no relay header) gets the real outcome, and adds back an ' +
          'unsubscribed person only when it sends `consent`.\n\n' +
          'Browser subscribes (a publishable key, or a secret key sending the visitor address in ' +
          '`X-Rekey-Client-Ip`) are limited to 5 a minute and 30 an hour per visitor address, 120 a ' +
          'minute per list, and the workspace `contactCaptureDailyCap`; a secret key with no visitor ' +
          'address, to 1200 a minute per list. Any suppression of the address blocks a browser ' +
          'subscribe. A filled `hp` honeypot stores ' +
          'nothing. `fields` are checked against the list `fieldSchema` (8 KB in total). Rekey sends ' +
          'no email from this route.',
        params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        body: {
          type: 'object',
          required: ['email'],
          // Any other field is refused by the handler. Not `additionalProperties:
          // false` here: the validator would silently strip the field instead.
          properties: {
            email: { type: 'string', maxLength: 254 },
            name: { type: 'string', maxLength: 120 },
            fields: { type: 'object', additionalProperties: true },
            consent: {
              type: 'object',
              properties: { granted: { type: 'boolean', enum: [true] }, version: { type: 'integer', minimum: 0 } },
              required: ['granted', 'version'],
            },
            sourceUrl: { type: 'string', maxLength: 2048 },
            hp: { type: 'string', maxLength: 500, description: 'Honeypot. Render it hidden and leave it empty.' },
          },
        },
        response: {
          200: ok(SUBSCRIBE_RESULT, 'Secret key with no visitor address: what happened.'),
          202: ok(SUBSCRIBE_RESULT, 'Publishable key, or a secret key naming the visitor: always `{status: "received"}`.'),
          ...errs({
            400:
              'VALIDATION_ERROR: the body does not match; CONTACT_FIELDS_INVALID: see `details.issues`; ' +
              "or CONTACT_CONSENT_REQUIRED: the list's lawful basis is consent and `consent` is missing.",
            ...AUTH_ERRORS,
            403: `${AUTH_ERRORS[403]}; or CONTACT_EMAIL_DOMAIN_NOT_ALLOWED: a disposable domain; or CONTACT_QUOTA_EXCEEDED (secret key with no visitor address only): the workspace is at maxContacts.`,
            404: NOT_FOUND,
            409: 'CONTACT_CONSENT_STALE: the consent text changed; re-fetch the list (`details.currentVersion`).',
            429: 'CONTACTS_RATE_LIMITED or RATE_LIMITED. Honour Retry-After.',
            503: 'DEPENDENCY_UNAVAILABLE: the rate-limit store is unreachable, so nothing was stored.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { key } = KeyParam.parse(req.params);
      const body = ListSubscribeRequestSchema.parse(req.body);
      const caller = callerOf(req);
      if (isAuthoritative(caller)) {
        return reply.status(200).send({ success: true, data: await subscribe(caller, key, body) });
      }
      try {
        await subscribe(caller, key, body);
      } catch (err) {
        if (!(err instanceof RekeyError && err.code === 'CONTACT_QUOTA_EXCEEDED')) throw err;
        await noteQuotaRefusal(caller.application, key);
      }
      return reply.status(202).send({ success: true, data: { status: 'received' } });
    },
  );
}
