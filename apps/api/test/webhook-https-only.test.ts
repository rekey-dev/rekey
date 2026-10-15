/**
 * A production deployment sends webhook payloads only over https.
 *
 * Plain http was accepted for any public host, so sign-up events, emails and
 * ids crossed the internet in clear. The rule holds at create, at update and
 * at delivery, and a deployment that allows private targets keeps http for
 * services on its own network.
 *
 * The suite runs with WEBHOOK_ALLOW_PRIVATE_TARGETS=true, so the flag is
 * set per test here, and production is entered for single calls.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { assertSafeUrlResolved } from '../src/lib/ssrf-guard.js';
import { attemptDelivery, PLAIN_HTTP_DELIVERY_ERROR } from '../src/modules/webhooks/webhook.service.js';
import { MCP_ADMIN_SCOPE, operatorMcpOAuthToken } from './operator-mcp-oauth-token.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

/** `env` is parsed once and the suite parses the flag as true, so each test sets the value it needs on the parsed object. */
const deployment = env as { WEBHOOK_ALLOW_PRIVATE_TARGETS: boolean };
const suiteDefault = deployment.WEBHOOK_ALLOW_PRIVATE_TARGETS;

async function inProduction<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await run();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

interface Workspace {
  session: string;
  tenantId: string;
  applicationId: string;
}

describe('plain http webhook URLs', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    deployment.WEBHOOK_ALLOW_PRIVATE_TARGETS = suiteDefault;
    await app.close();
  });
  beforeEach(() => {
    deployment.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
  });

  async function workspace(slug: string): Promise<Workspace> {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `https-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    const data = signUp.json().data as { accessToken: string; activeTenantId: string };
    const application = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${data.accessToken}` },
      payload: { name: `App ${slug}`, slug: `https-${slug}` },
    });
    return {
      session: data.accessToken,
      tenantId: data.activeTenantId,
      applicationId: (application.json().data as { id: string }).id,
    };
  }

  function create(w: Workspace, url: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.applicationId}/webhooks`,
      headers: { authorization: `Bearer ${w.session}` },
      payload: { url, events: ['*'] },
    });
  }

  function list(w: Workspace) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.applicationId}/webhooks`,
      headers: { authorization: `Bearer ${w.session}` },
    });
  }

  async function pendingDelivery(applicationId: string, endpointId: string): Promise<string> {
    const row = await prisma.webhookDelivery.create({
      data: {
        endpointId,
        applicationId,
        eventId: `evt_${endpointId}`,
        eventType: 'user.created',
        payload: { id: `evt_${endpointId}`, type: 'user.created', data: { email: 'someone@example.com' } },
      },
    });
    return row.id;
  }

  it('the outbound guard refuses public http in production, and accepts it in development or with private targets allowed', async () => {
    await expect(
      inProduction(() => assertSafeUrlResolved('http://example.com/hook', { allowPrivate: false })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'URL_NOT_HTTPS' });

    const inDevelopment = await assertSafeUrlResolved('http://example.com/hook', { allowPrivate: false });
    expect(inDevelopment.length).toBeGreaterThan(0);

    await expect(
      inProduction(() => assertSafeUrlResolved('http://example.com/hook', { allowPrivate: true })),
    ).resolves.toEqual([]);
    const https = await inProduction(() => assertSafeUrlResolved('https://example.com/hook', { allowPrivate: false }));
    expect(https.length).toBeGreaterThan(0);
  });

  it('create refuses public http in production with URL_NOT_HTTPS, and stores nothing', async () => {
    const w = await workspace('create');

    const refused = await inProduction(() => create(w, 'http://hooks.example.com/rekey'));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'URL_NOT_HTTPS' });
    expect(refused.json().error.fix).toContain('https://');
    expect(await prisma.webhookEndpoint.count({ where: { applicationId: w.applicationId } })).toBe(0);

    const accepted = await inProduction(() => create(w, 'https://hooks.example.com/rekey'));
    expect(accepted.statusCode).toBe(201);

    const listed = await inProduction(() => list(w));
    expect(listed.json().data).toMatchObject({ httpsRequired: true });
  });

  it('update refuses a change to public http in production and keeps the stored URL', async () => {
    const w = await workspace('update');
    const endpointId = ((await create(w, 'https://hooks.example.com/rekey')).json().data as { id: string }).id;

    const refused = await inProduction(() =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${w.applicationId}/webhooks/${endpointId}`,
        headers: { authorization: `Bearer ${w.session}` },
        payload: { url: 'http://hooks.example.com/rekey' },
      }),
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('URL_NOT_HTTPS');
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } })).url).toBe(
      'https://hooks.example.com/rekey',
    );
  });

  it('the operator MCP tools apply the same rules as the panel routes', async () => {
    const w = await workspace('mcp');
    const token = await operatorMcpOAuthToken(app, w.session, w.tenantId, MCP_ADMIN_SCOPE);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      const result = (res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
      return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
    };

    const plainHttp = await inProduction(() =>
      call('create_webhook_endpoint', { applicationId: w.applicationId, url: 'http://hooks.example.com/rekey', events: ['*'] }),
    );
    expect(plainHttp).toMatchObject({ isError: true, data: { code: 'URL_NOT_HTTPS' } });

    const privateTarget = await call('create_webhook_endpoint', {
      applicationId: w.applicationId,
      url: 'https://10.0.0.5/rekey',
      events: ['*'],
    });
    expect(privateTarget).toMatchObject({ isError: true, data: { code: 'WEBHOOK_URL_UNSAFE' } });

    const created = await call('create_webhook_endpoint', {
      applicationId: w.applicationId,
      url: 'https://hooks.example.com/rekey',
      events: ['*'],
    });
    expect(created.isError).toBe(false);
    const repointed = await inProduction(() =>
      call('update_webhook_endpoint', { applicationId: w.applicationId, endpointId: created.data.id, url: 'http://hooks.example.com/rekey' }),
    );
    expect(repointed).toMatchObject({ isError: true, data: { code: 'URL_NOT_HTTPS' } });
    expect(await prisma.webhookEndpoint.count({ where: { applicationId: w.applicationId, url: { startsWith: 'http://' } } })).toBe(0);
  });

  it('an OIDC issuer over plain http is refused at save in production', async () => {
    const w = await workspace('oidc');
    const save = (issuerUrl: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${w.applicationId}/oauth-config/oidc`,
        headers: { authorization: `Bearer ${w.session}` },
        payload: { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://app.example.com/callback', issuerUrl },
      });

    const refused = await inProduction(() => save('http://login.example.com'));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('URL_NOT_HTTPS');
    const stored = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
    expect(JSON.stringify(stored)).not.toContain('login.example.com');

    expect((await inProduction(() => save('https://login.example.com'))).statusCode).toBe(200);
    expect((await save('http://login.example.com')).statusCode).toBe(200);
  });

  it('an endpoint already stored as http is not sent to in production, and every attempt says why', async () => {
    const w = await workspace('existing');
    const requests: string[] = [];
    const receiver = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end('{}');
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    try {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { applicationId: w.applicationId, url, events: ['*'], secret: 'whsec_test_secret_value_0123456789' },
      });
      const deliveryId = await pendingDelivery(w.applicationId, endpoint.id);

      const MAX_ATTEMPTS = 8;
      let row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && row.status === 'PENDING'; attempt++) {
        await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { nextAttemptAt: new Date() } });
        await inProduction(() => attemptDelivery(deliveryId));
        row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
        expect(row.error, `attempt ${attempt}`).toBe(PLAIN_HTTP_DELIVERY_ERROR);
      }
      expect(row.status).toBe('FAILED');
      expect(requests).toEqual([]);

      const deliveries = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${w.applicationId}/webhooks/${endpoint.id}/deliveries`,
        headers: { authorization: `Bearer ${w.session}` },
      });
      const shown = (deliveries.json().data.items as Array<{ id: string; error: string | null }>).find((d) => d.id === deliveryId);
      expect(shown?.error).toMatch(/^URL_NOT_HTTPS: /);
      expect(shown?.error).toContain('https://');
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });

  it('with private targets allowed, production still creates and delivers to an http endpoint', async () => {
    deployment.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
    const w = await workspace('private');
    const requests: string[] = [];
    const receiver = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end('{}');
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    try {
      const created = await inProduction(() => create(w, url));
      expect(created.statusCode).toBe(201);
      expect((await inProduction(() => list(w))).json().data).toMatchObject({ httpsRequired: false });

      const endpointId = (created.json().data as { id: string }).id;
      const deliveryId = await pendingDelivery(w.applicationId, endpointId);
      await inProduction(() => attemptDelivery(deliveryId));

      expect(requests).toEqual(['/hook']);
      expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } })).toMatchObject({
        status: 'SUCCEEDED',
        error: null,
      });
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});
