/**
 * Operator MCP tools for profile fields, onboarding and lists, called over
 * the MCP endpoint with a personal access token: each runs the REST route's
 * service, each is governed by its scope, and a read token sees no writes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TOOL_SCOPES, allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { operatorMcpOAuthToken } from './operator-mcp-oauth-token.js';

operatorsConfirmTheirEmail();

const TOOLS = {
  get_profile_schema: 'end-users:read',
  set_profile_schema: 'end-users:write',
  update_end_user_profile: 'end-users:write',
  complete_onboarding: 'end-users:write',
  skip_onboarding: 'end-users:write',
  create_contact_list: 'audience:write',
  update_contact_list: 'audience:write',
  archive_contact_list: 'audience:write',
  restore_contact_list: 'audience:write',
  list_list_members: 'audience:read',
  list_list_submissions: 'audience:read',
  unsubscribe_list_member: 'audience:write',
} as const;
const WRITES = Object.keys(TOOLS).filter((t) => TOOLS[t as keyof typeof TOOLS].endsWith(':write'));

describe('operator MCP profile and list tools', () => {
  let app: FastifyInstance;
  const { inject, auth, world, mintKey, memberWith, createList } = contactsHarness(() => app, '88');

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function mintPat(w: ContactsWorld, scopes: string[]): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: auth(w.ownerToken),
      payload: { name: 'agent', scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
  }

  async function rpc(token: string, method: string, params?: Record<string, unknown>) {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: auth(token),
      payload: { jsonrpc: '2.0', id: 1, method, ...(params && { params }) },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
  }

  async function call<T = Record<string, unknown>>(token: string, name: string, args: Record<string, unknown>) {
    const { result } = await rpc(token, 'tools/call', { name, arguments: args });
    return { isError: result.isError === true, data: JSON.parse(result.content![0]!.text) as T };
  }

  async function ok<T = Record<string, unknown>>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
    const res = await call<T>(token, name, args);
    expect(res.isError, JSON.stringify(res.data)).toBe(false);
    return res.data;
  }

  it('governs each tool by the scope its REST route declares', () => {
    for (const [name, scope] of Object.entries(TOOLS)) {
      expect(allOperatorTools.some((t) => t.name === name), name).toBe(true);
      expect(TOOL_SCOPES[name], name).toBe(scope);
    }
  });

  it('a read token sees only the read tools and is refused a write', async () => {
    const w = await world();
    const token = await mintPat(w, ['read']);
    const listed = (await rpc(token, 'tools/list')).result.tools!.map((t) => t.name);
    for (const name of Object.keys(TOOLS)) expect(listed.includes(name), name).toBe(!WRITES.includes(name));

    const refused = await call<{ error: string }>(token, 'create_contact_list', { applicationId: w.appId, key: 'x', name: 'X' });
    expect(refused.isError).toBe(true);
    expect(refused.data.error).toMatch(/write access/i);
  });

  it('keeps list addresses away from a member, even one who can read the list in the panel', async () => {
    const w = await world();
    const memberSession = await memberWith(w, 'APP_ADMIN');
    const token = await operatorMcpOAuthToken(app, memberSession, w.tenantId, 'mcp:operator:read');

    expect((await createList(w)).statusCode).toBe(201);
    const listed = (await rpc(token, 'tools/list')).result.tools!.map((t) => t.name);
    expect(listed).toContain('list_contact_lists');
    expect(listed).not.toContain('list_list_members');
    expect(listed).not.toContain('list_list_submissions');
    for (const name of ['list_list_members', 'list_list_submissions']) {
      const refused = await call(token, name, { applicationId: w.appId, key: 'newsletter' });
      expect(refused.isError, name).toBe(true);
    }

    const ownerToken = await mintPat(w, ['read']);
    await ok(ownerToken, 'list_list_members', { applicationId: w.appId, key: 'newsletter' });
  });

  it('sets the onboarding questions and drives one end user through onboarding', async () => {
    const w = await world();
    const token = await mintPat(w, ['read', 'applications:write']);
    const fields = [{ key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true }];

    const read = await ok<{ version: number }>(token, 'get_profile_schema', { applicationId: w.appId });
    await ok(token, 'set_profile_schema', { applicationId: w.appId, fields, version: read.version });
    const stale = await call<{ code: string }>(token, 'set_profile_schema', { applicationId: w.appId, fields, version: read.version });
    expect(stale.data.code).toBe('PROFILE_SCHEMA_CHANGED');

    const secret = await mintKey(w);
    const signUp = await inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: auth(secret),
      payload: { email: `eu-${w.tag}@example.com`, password: 'pw-one-two-three' },
    });
    const endUserId = (signUp.json().data as { endUser: { id: string } }).endUser.id;

    const incomplete = await call<{ code: string }>(token, 'complete_onboarding', { applicationId: w.appId, endUserId });
    expect(incomplete.data.code).toBe('PROFILE_INCOMPLETE');
    expect(await ok(token, 'skip_onboarding', { applicationId: w.appId, endUserId })).toMatchObject({ onboardingStatus: 'skipped' });
    expect(
      await ok(token, 'update_end_user_profile', { applicationId: w.appId, endUserId, profile: { company: 'Acme' } }),
    ).toMatchObject({ profile: { company: 'Acme' } });
    expect(await ok(token, 'complete_onboarding', { applicationId: w.appId, endUserId })).toMatchObject({
      onboardingStatus: 'completed',
    });
  });

  it('creates, changes, archives and restores a list, and takes a member off it', async () => {
    const w = await world();
    const token = await mintPat(w, ['read', 'applications:write']);
    const at = { applicationId: w.appId, key: 'feedback' };

    await ok(token, 'create_contact_list', {
      ...at,
      name: 'Feedback',
      lawfulBasis: 'contract',
      fieldSchema: [{ name: 'msg', label: 'Message', type: 'text' }],
    });
    expect(await ok(token, 'update_contact_list', { ...at, name: 'Product feedback', submissionRetentionDays: 30 })).toMatchObject({
      name: 'Product feedback',
      submissionRetentionDays: 30,
    });
    expect(await ok(token, 'archive_contact_list', at)).toMatchObject({ archivedAt: expect.any(String) });
    expect(await ok(token, 'restore_contact_list', at)).toMatchObject({ archivedAt: null });

    const secret = await mintKey(w);
    const joined = await inject({
      method: 'POST',
      url: '/api/v1/lists/feedback/subscribe',
      headers: auth(secret),
      payload: { email: 'reader@example.com', fields: { msg: 'hello' } },
    });
    expect(joined.statusCode, joined.body).toBeLessThan(300);

    const members = await ok<{ items: Array<{ memberId: string; email: string }> }>(token, 'list_list_members', at);
    expect(members.items.map((m) => m.email)).toEqual(['reader@example.com']);
    const submissions = await ok<{ items: Array<{ fields: unknown }> }>(token, 'list_list_submissions', at);
    expect(submissions.items[0]!.fields).toEqual({ msg: 'hello' });

    expect(await ok(token, 'unsubscribe_list_member', { ...at, memberId: members.items[0]!.memberId })).toMatchObject({
      status: 'unsubscribed',
    });

    const missing = await call<{ code: string }>(token, 'archive_contact_list', { ...at, key: 'nope' });
    expect(missing.data.code).toBe('LIST_NOT_FOUND');
  });
});
