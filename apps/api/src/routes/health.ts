import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok', service: 'relipay-api' };
  });

  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', db: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'readiness probe: db unreachable');
      return reply.status(503).send({ status: 'not_ready', db: 'unreachable' });
    }
  });
}
