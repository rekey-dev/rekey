/**
 * Health endpoints, split along the liveness/readiness line.
 *
 *   /health/live  — is the process up? Never touches a dependency. This is what
 *                   a container healthcheck should use: restarting the API
 *                   cannot fix a database outage, so a dependency failure must
 *                   not look like a dead process.
 *   /health/ready — can we actually serve traffic? Checks Postgres and Redis.
 *                   This is what a load balancer should gate on.
 *   /health       — dependency-aware alias of /health/ready.
 *
 * That last one is deliberate. `/health` is the obvious name and the one
 * operators wire into their LB or uptime monitor without reading docs, and it
 * used to return `{status:'ok'}` unconditionally — green during a total
 * database outage, so nothing failed over and no alert fired. Making the
 * naive choice the safe choice matters more than purity here.
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';

interface DependencyReport {
  ready: boolean;
  db: 'ok' | 'unreachable';
  redis: 'ok' | 'unreachable' | 'not_configured';
}

async function checkDependencies(app: FastifyInstance): Promise<DependencyReport> {
  let db: DependencyReport['db'] = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    app.log.error({ err }, 'readiness probe: db unreachable');
    db = 'unreachable';
  }

  // Redis is required at boot — enforced by `assertRedisReachable` in
  // modules/webhooks/webhook.queue.ts, not by lib/redis.ts (which returns null
  // and swallows errors). The global rate limiter fails open, though, so the API
  // can still serve reads while Redis is down —
  // degraded, not dead. Report it so an operator can see which half is sick
  // instead of guessing from a generic 500.
  let redis: DependencyReport['redis'] = 'not_configured';
  const client = getRedis();
  if (client) {
    try {
      // Explicit deadline. ioredis's `connectTimeout` covers establishing the
      // socket, not an individual command, so a Redis that accepted the
      // connection and then wedged could hang this endpoint indefinitely —
      // a health check that never answers is worse than one that lies.
      await Promise.race([
        client.ping(),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('redis ping timed out')), 1_000),
        ),
      ]);
      redis = 'ok';
    } catch (err) {
      app.log.error({ err }, 'readiness probe: redis unreachable');
      redis = 'unreachable';
    }
  }

  return { ready: db === 'ok' && redis !== 'unreachable', db, redis };
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: no dependency calls, and exempt from the rate limiter so a
  // Redis outage can't make the process look dead to an orchestrator.
  app.get(
    '/health/live',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        security: [],
        summary: 'Liveness probe — is the process up?',
        description:
          'Returns 200 as soon as the process can serve HTTP. Touches no dependencies, so ' +
          'it stays green through a database or Redis outage. Unauthenticated and exempt ' +
          'from rate limiting so an orchestrator can always reach it.',
        response: {
          200: {
            description: 'The process is up. No `{success, data}` envelope — this route predates it.',
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok'] },
              service: { type: 'string', enum: ['rekey-api'] },
            },
            required: ['status', 'service'],
          },
        },
      },
    },
    async () => {
      return { status: 'ok', service: 'rekey-api' };
    },
  );

  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        security: [],
        summary: 'Readiness probe — can the process serve traffic?',
        description:
          '503 `not_ready` when Postgres is unreachable or a configured Redis is down, 200 ' +
          '`ready` otherwise. Unauthenticated and exempt from rate limiting.',
        response: {
          200: {
            description: 'Ready to serve traffic. No `{success, data}` envelope — this route predates it.',
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ready'] },
              db: { type: 'string', enum: ['ok', 'unreachable'] },
              redis: { type: 'string', enum: ['ok', 'unreachable', 'not_configured'] },
            },
            required: ['status', 'db', 'redis'],
          },
          503: {
            description:
              'Not ready: Postgres is unreachable, or a configured Redis is down. No ' +
              '`{success, error}` envelope — this route answers directly, not through rekeyErrorHandler.',
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['not_ready'] },
              db: { type: 'string', enum: ['ok', 'unreachable'] },
              redis: { type: 'string', enum: ['ok', 'unreachable', 'not_configured'] },
            },
            required: ['status', 'db', 'redis'],
          },
        },
      },
    },
    async (_req, reply) => {
      const report = await checkDependencies(app);
      if (!report.ready) {
        return reply
          .status(503)
          .send({ status: 'not_ready', db: report.db, redis: report.redis });
      }
      return { status: 'ready', db: report.db, redis: report.redis };
    },
  );

  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        security: [],
        summary: 'Aggregate health, with per-dependency detail',
        description:
          '200 `ok` or 503 `degraded`, plus `db` and `redis` fields so an operator can see ' +
          'which half is sick. Unauthenticated and exempt from rate limiting.',
        response: {
          200: {
            description: 'Healthy. No `{success, data}` envelope — this route predates it.',
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok'] },
              service: { type: 'string', enum: ['rekey-api'] },
              db: { type: 'string', enum: ['ok', 'unreachable'] },
              redis: { type: 'string', enum: ['ok', 'unreachable', 'not_configured'] },
            },
            required: ['status', 'service', 'db', 'redis'],
          },
          503: {
            description:
              'Degraded: Postgres is unreachable, or a configured Redis is down. No ' +
              '`{success, error}` envelope — this route answers directly, not through rekeyErrorHandler.',
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['degraded'] },
              service: { type: 'string', enum: ['rekey-api'] },
              db: { type: 'string', enum: ['ok', 'unreachable'] },
              redis: { type: 'string', enum: ['ok', 'unreachable', 'not_configured'] },
            },
            required: ['status', 'service', 'db', 'redis'],
          },
        },
      },
    },
    async (_req, reply) => {
      const report = await checkDependencies(app);
      if (!report.ready) {
        return reply.status(503).send({
          status: 'degraded',
          service: 'rekey-api',
          db: report.db,
          redis: report.redis,
        });
      }
      // `status: 'ok'` retained verbatim — existing monitors and the compose
      // healthcheck match on it.
      return { status: 'ok', service: 'rekey-api', db: report.db, redis: report.redis };
    },
  );
}
