/**
 * `GET /tenant/applications/:id` reports the hosted-portal origin the API
 * actually serves, so the panel can tell "portal live at <url>" from "portal
 * on, but this deployment runs no portal". It used to guess from its own
 * build-time variable and showed a placeholder URL as live.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

const mutableEnv = env as { PUBLIC_PORTAL_URL?: string | undefined };
const configured = mutableEnv.PUBLIC_PORTAL_URL;

describe('Application portalBaseUrl', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  // The shared setup truncates every table before each test.
  beforeEach(async () => {
    const tag = `pbu-${Math.random().toString(36).slice(2, 8)}`;
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      remoteAddress: '10.98.0.1',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Portal Base Co' },
    });
    expect(su.statusCode, su.body).toBe(201);
    token = (su.json().data as { accessToken: string }).accessToken;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      remoteAddress: '10.98.0.1',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: tag, slug: tag },
    });
    expect(created.statusCode, created.body).toBe(201);
    appId = (created.json().data as { id: string }).id;
  });
  afterEach(() => {
    mutableEnv.PUBLIC_PORTAL_URL = configured;
  });
  afterAll(async () => {
    await app.close();
  });

  const read = () =>
    app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}`,
      remoteAddress: '10.98.0.1',
      headers: { authorization: `Bearer ${token}` },
    });

  it('is the origin of PUBLIC_PORTAL_URL when the deployment runs a portal', async () => {
    mutableEnv.PUBLIC_PORTAL_URL = 'https://portal.example.test/some/path';
    const res = await read();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.portalBaseUrl).toBe('https://portal.example.test');
  });

  it('is null, not absent, when PUBLIC_PORTAL_URL is unset', async () => {
    delete mutableEnv.PUBLIC_PORTAL_URL;
    const res = await read();
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as Record<string, unknown>;
    expect(data).toHaveProperty('portalBaseUrl');
    expect(data.portalBaseUrl).toBeNull();
  });
});
