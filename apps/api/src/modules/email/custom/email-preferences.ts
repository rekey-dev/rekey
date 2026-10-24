/**
 * Which notification email one end user receives, per topic:
 *
 *   GET   /api/v1/users/:id/email-preferences   secret key with `auth:read`
 *   PATCH /api/v1/users/:id/email-preferences   secret key with `email:send`
 *
 * The same records the one-click unsubscribe writes, so an in-app settings
 * page and the link in the email always agree.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CUSTOM_EMAIL_TOPIC_RE, type EmailPreferences, type EmailTopicState } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { assertEndUserInApplication } from '../../../lib/end-users.js';
import { requireApiKey, requireScope } from '../../../middleware/api-key-auth.js';
import { errs, ok } from '../../../lib/openapi.js';
import { suppressionCovers } from '../send-policy.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import { optOutIn } from './unsubscribe.service.js';
import { topicUnknown } from './errors.js';

/** Every topic a notification template of this Application was ever published with, sorted. */
export async function publishedTopics(applicationId: string): Promise<string[]> {
  const versions = await prisma.customEmailTemplateVersion.findMany({
    where: { applicationId, category: 'notification' },
    distinct: ['templateId', 'topic'],
    select: { topic: true, template: { select: { key: true } } },
  });
  return [...new Set(versions.map((v) => v.topic ?? v.template.key))].sort();
}

async function addressOf(applicationId: string, endUserId: string): Promise<string> {
  await assertEndUserInApplication(applicationId, endUserId, 'Confirm the id belongs to the Application this secret key represents.');
  const user = await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId }, select: { email: true, erasedAt: true } });
  if (user.erasedAt !== null) {
    throw new RekeyError({
      statusCode: 410,
      code: 'END_USER_ERASED',
      message: 'This end-user has been erased (GDPR); only a tombstone remains.',
      fix: 'An erased end user has no email preferences. Drop them from your own records.',
    });
  }
  return user.email.toLowerCase();
}

/** The preferences of one end user. A suppression of every email reads as unsubscribed everywhere. */
export async function readPreferences(applicationId: string, endUserId: string): Promise<EmailPreferences> {
  const address = await addressOf(applicationId, endUserId);
  const [topics, suppression, optOuts] = await Promise.all([
    publishedTopics(applicationId),
    prisma.emailSuppression.findUnique({
      where: { applicationId_address: { applicationId, address } },
      select: { category: true },
    }),
    prisma.emailTopicOptOut.findMany({ where: { applicationId, address }, select: { topic: true } }),
  ]);
  const leftAll = suppression !== null && suppressionCovers(suppression.category, 'notification');
  const left = new Set(optOuts.map((o) => o.topic));
  const state = (topic: string): EmailTopicState => (leftAll || left.has(topic) ? 'unsubscribed' : 'subscribed');
  return {
    allNotifications: leftAll ? 'unsubscribed' : 'subscribed',
    topics: Object.fromEntries(topics.map((t) => [t, state(t)])),
  };
}

/**
 * Set topics. `unsubscribed` records an opt-out and sends `email.unsubscribed`;
 * `subscribed` removes only a topic opt-out. A suppression of the whole
 * category or of every email is never lifted here: that is the recipient's
 * "stop all" or the operator's entry, and it keeps every topic unsubscribed.
 */
export async function updatePreferences(
  applicationId: string,
  endUserId: string,
  changes: Record<string, EmailTopicState>,
): Promise<EmailPreferences> {
  const address = await addressOf(applicationId, endUserId);
  const known = new Set(await publishedTopics(applicationId));
  const unknown = Object.keys(changes).filter((t) => !known.has(t));
  if (unknown.length > 0) throw topicUnknown(unknown);
  const entries = Object.entries(changes);
  const resubscribe = entries.filter(([, state]) => state === 'subscribed').map(([topic]) => topic);
  const deliveryIds = await prisma.$transaction(async (tx) => {
    await tx.emailTopicOptOut.deleteMany({ where: { applicationId, address, topic: { in: resubscribe } } });
    const ids: string[] = [];
    for (const [topic, state] of entries) {
      if (state === 'unsubscribed') ids.push(...(await optOutIn(tx, applicationId, address, topic)));
    }
    return ids;
  });
  kickDeliveries(deliveryIds);
  return readPreferences(applicationId, endUserId);
}

const PatchBody = z
  .object({
    topics: z
      .record(z.string().regex(CUSTOM_EMAIL_TOPIC_RE), z.enum(['subscribed', 'unsubscribed']))
      .refine((t) => Object.keys(t).length > 0 && Object.keys(t).length <= 50, 'Name 1 to 50 topics.'),
  })
  .strict();

const STATE = { type: 'string', enum: ['subscribed', 'unsubscribed'] } as const;
const PREFERENCES = {
  type: 'object',
  properties: {
    allNotifications: {
      ...STATE,
      description: '`unsubscribed`: they left every notification email, so every topic reads unsubscribed.',
    },
    topics: {
      type: 'object',
      additionalProperties: STATE,
      description: 'Every topic ever published on a notification template of this Application.',
    },
  },
  required: ['allNotifications', 'topics'],
} as const;

const ERRORS = {
  401: 'API_KEY_MISSING / API_KEY_INVALID: no key, or not a valid secret key for an Application.',
  403: 'API_KEY_SCOPE_INSUFFICIENT: the key lacks the scope named above; or IP_NOT_ALLOWED.',
  404: 'END_USER_NOT_FOUND: no end user with that id in this Application.',
  410: 'END_USER_ERASED: the account was erased (GDPR).',
} as const;

export async function emailPreferencesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);
  const params = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
  const Id = z.object({ id: z.string().min(1).max(64) });

  app.get(
    '/:id/email-preferences',
    {
      onRequest: requireScope('auth:read'),
      schema: {
        tags: ['Public · Email'],
        summary: "Read an end user's notification email preferences",
        description:
          'Per topic, whether this end user receives notification custom email. The one-click unsubscribe ' +
          'link in the email writes the same records. Critical and built-in mail never read them. Secret ' +
          'key with `auth:read`.',
        security: [{ apiKey: [] }],
        params,
        response: { 200: ok(PREFERENCES, 'The preferences.'), ...errs(ERRORS) },
      },
    },
    async (req) => {
      const { id } = Id.parse(req.params);
      return { success: true, data: await readPreferences(req.application!.id, id) };
    },
  );

  app.patch(
    '/:id/email-preferences',
    {
      onRequest: requireScope('email:send'),
      schema: {
        tags: ['Public · Email'],
        summary: "Change an end user's notification email preferences",
        description:
          'Set named topics to `subscribed` or `unsubscribed`; topics left out are unchanged. ' +
          'Applied together or not at all. `unsubscribed` sends `email.unsubscribed` when it changes what they ' +
          'receive. `subscribed` lifts only ' +
          'a topic opt-out: someone who left every notification email, or whom an operator suppressed, ' +
          'stays unsubscribed everywhere. Requires the elevated `email:send` scope, so a default key ' +
          'cannot sign someone back up.',
        security: [{ apiKey: [] }],
        params,
        body: {
          type: 'object',
          required: ['topics'],
          properties: { topics: { type: 'object', additionalProperties: STATE } },
        },
        response: {
          200: ok(PREFERENCES, 'The preferences after the change.'),
          ...errs({
            ...ERRORS,
            400:
              'VALIDATION_ERROR: the body does not match; or EMAIL_TOPIC_UNKNOWN: no notification template ' +
              'was ever published with that topic.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = Id.parse(req.params);
      const { topics } = PatchBody.parse(req.body);
      return { success: true, data: await updatePreferences(req.application!.id, id, topics) };
    },
  );
}
