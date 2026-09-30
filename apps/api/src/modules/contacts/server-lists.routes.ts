/**
 * List routes for the Application's own server only (secret key). A
 * publishable key is refused by `requireApiKey` before any of these run.
 *
 *   GET    /api/v1/lists                       the lists, with counts
 *   GET    /api/v1/lists/:key/members          read the members out (contacts:read)
 *   DELETE /api/v1/lists/:key/members/:email   take someone off a list
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errs, ok, okPage } from '../../lib/openapi.js';
import { paged } from '../../lib/pagination.js';
import { requireApiKey, requireScope } from '../../middleware/api-key-auth.js';
import { listMembers, unsubscribe } from './members.service.js';
import { listsService } from './lists.service.js';

const MemberParam = z.object({ key: z.string().min(1).max(64), email: z.string().trim().email().max(254) });

const SECURITY = [{ apiKey: [] }];
const TAGS = ['Public · Lists'];

const AUTH_ERRORS = {
  401: 'API_KEY_MISSING / API_KEY_INVALID: no key, not a secret key (a publishable key is refused), or unknown.',
  403: 'API_KEY_SCOPE_INSUFFICIENT: the key lacks `contacts:write`; or IP_NOT_ALLOWED; or APPLICATION_DISABLED.',
} as const;

const MembersQuerySchema = z.object({
  status: z.enum(['subscribed', 'unsubscribed', 'all']).default('subscribed'),
  updatedSince: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const MEMBER = {
  type: 'object',
  properties: {
    contactId: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['subscribed', 'unsubscribed'] },
    source: { type: 'string', enum: ['publishable', 'secret', 'operator'] },
    consentVersion: { type: 'integer', nullable: true },
    consentAt: { type: 'string', format: 'date-time', nullable: true },
    subscribedAt: { type: 'string', format: 'date-time' },
    unsubscribedAt: { type: 'string', format: 'date-time', nullable: true },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['contactId', 'email', 'status', 'source', 'subscribedAt', 'updatedAt'],
} as const;

const LIST_SUMMARY = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['newsletter', 'waitlist', 'contact_form', 'generic'] },
    publicCapture: { type: 'boolean' },
    archived: { type: 'boolean' },
    subscribed: { type: 'integer' },
    unsubscribed: { type: 'integer' },
  },
  required: ['key', 'name', 'kind', 'publicCapture', 'archived', 'subscribed', 'unsubscribed'],
} as const;

export async function serverListsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);

  app.get(
    '/',
    {
      onRequest: requireScope('contacts:write'),
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "This Application's lists, with member counts",
        description:
          'Needs `contacts:write`, which `*` keys hold. Counts only, never addresses: reading members ' +
          'needs `contacts:read`. Archived lists included, flagged `archived`.',
        response: {
          200: okPage(LIST_SUMMARY, 'Every list, by key.'),
          ...errs({ 401: AUTH_ERRORS[401], 403: AUTH_ERRORS[403] }),
        },
      },
    },
    async (req) => {
      const lists = await listsService.list(req.application!.id);
      const items = lists
          .map((l) => ({
            key: l.key,
            name: l.name,
            kind: l.kind,
            publicCapture: l.publicCapture,
            archived: l.archivedAt !== null,
            subscribed: l.counts.subscribed,
            unsubscribed: l.counts.unsubscribed,
          }))
          .sort((a, b) => a.key.localeCompare(b.key));
      return { success: true, data: paged(items, items.length, items.length, 0) };
    },
  );

  app.get(
    '/:key/members',
    {
      onRequest: requireScope('contacts:read'),
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "Read a list's members, for syncing to your email tool",
        description:
          'Needs a secret key minted with the elevated **`contacts:read`** scope; `*` does not include ' +
          'it, because this reads out every address on the list. Oldest change first. To sync, store ' +
          'the last `updatedAt` you saw and pass it as `updatedSince` next time: unsubscribes move ' +
          '`updatedAt` too, so read `status: all` to hear about them. Page with `cursor`.',
        params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['subscribed', 'unsubscribed', 'all'], default: 'subscribed' },
            updatedSince: { type: 'string', format: 'date-time', description: 'Only members changed after this.' },
            cursor: { type: 'string', description: '`nextCursor` from the previous page.' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                items: { type: 'array', items: MEMBER },
                nextCursor: { type: 'string', nullable: true, description: 'Null on the last page.' },
              },
              required: ['items', 'nextCursor'],
            },
            'A page of members.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR: a query parameter does not match; or CONTACT_CURSOR_INVALID.',
            401: AUTH_ERRORS[401],
            403: 'API_KEY_SCOPE_INSUFFICIENT: the key was not minted with `contacts:read`; or IP_NOT_ALLOWED; or APPLICATION_DISABLED.',
            404: 'LIST_NOT_FOUND: no list with that key; `details.available` lists the keys.',
          }),
        },
      },
    },
    async (req) => {
      const { key } = z.object({ key: z.string().min(1).max(64) }).parse(req.params);
      const query = MembersQuerySchema.parse(req.query);
      return { success: true, data: await listMembers(req.application!.id, key, query) };
    },
  );

  app.delete(
    '/:key/members/:email',
    {
      onRequest: requireScope('contacts:write'),
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Take someone off a list',
        description:
          'Marks the member unsubscribed and sends `contact.unsubscribed`. Idempotent: someone who ' +
          'was not on the list, or already left, answers `not_subscribed` and nothing is sent. Use it to ' +
          'sync unsubscribes from your email tool. Works on archived lists. Only a secret-key subscribe ' +
          'with `consent` can add the person back.',
        params: {
          type: 'object',
          properties: { key: { type: 'string' }, email: { type: 'string' } },
          required: ['key', 'email'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { status: { type: 'string', enum: ['unsubscribed', 'not_subscribed'] } },
              required: ['status'],
            },
            'What changed.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR: `email` is not an email address.',
            ...AUTH_ERRORS,
            404: 'LIST_NOT_FOUND: no list with that key; `details.available` lists the keys.',
          }),
        },
      },
    },
    async (req) => {
      const { key, email } = MemberParam.parse(req.params);
      return { success: true, data: await unsubscribe(req.application!.id, key, email) };
    },
  );
}
