/**
 * Every operator route says what it is.
 *
 * The permission model reads `config.access` off the route (see
 * lib/route-access.ts). A route that ships without one is a route the gate
 * cannot reason about, and the failure mode is silent, because an
 * unclassified route is not refused, it is simply not governed. So this test
 * fails the build instead.
 *
 * It reads the LIVE route table, what the server actually registered, via the
 * `onRoute` hook, not a source grep. A route added to any file under an
 * operator prefix lands here the moment it is registered. Same discipline as
 * `cross-tenant-matrix.test.ts`, which reads `app.swagger()` for the same
 * reason.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { accessDeclarationRequired, routeAccessIsValid } from '../src/lib/route-access.js';
import { ALL_SCOPES, expandScopes, isScope, presetScopes } from '../src/lib/operator-scopes.js';

describe('route access declarations', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const label = (m: string | string[], u: string): string =>
    `${Array.isArray(m) ? m.join('|') : m} ${u}`;

  it('every route under an operator prefix declares config.access', () => {
    const governed = app.routeAccess.filter((r) => accessDeclarationRequired(r.url));
    // Sanity: the table is populated at all. The seven operator route files
    // register well over a hundred routes; a hook that never fired would make
    // the assertion below pass vacuously.
    expect(governed.length).toBeGreaterThan(120);

    const missing = governed
      .filter((r) => r.access === undefined)
      .map((r) => label(r.method, r.url));
    expect(
      missing,
      'an operator route has no config.access — add { scope }, { floor }, { open } or { project }',
    ).toEqual([]);
  });

  it('every declaration is well-formed and names a scope the registry knows', () => {
    const bad = app.routeAccess
      .filter((r) => r.access !== undefined && !routeAccessIsValid(r.access))
      .map((r) => `${label(r.method, r.url)} → ${JSON.stringify(r.access)}`);
    expect(bad).toEqual([]);
  });

  it('the floors are floors: no scope is declared on a route the spec keeps role-gated', () => {
    // These may never carry a scope. A scope here is the escalation path the
    // spec's §2.3 exists to prevent, `team:write` on a member would let them
    // grant themselves everything and then rewrite their own scopes.
    const mustBeFloor = [
      /\/impersonate(\/end)?$/,
      /\/end-users\/:euid\/export$/,
      /\/promote$/,
      /\/disable$/,
      /^\/api\/v1\/tenant\/workspace\/members\/:id(\/grants(\/:applicationId)?)?$/,
      /^\/api\/v1\/tenant\/workspace\/invitations(\/:id)?$/,
      /^\/api\/v1\/tenant\/workspace\/limits$/,
      // PATCH carries a security control (the operator MCP switch); GET and
      // POST on the same URL are open, not scoped, so the regex is safe.
      /^\/api\/v1\/tenant\/workspace$/,
    ];
    const violations = app.routeAccess
      .filter((r) => mustBeFloor.some((re) => re.test(r.url)))
      .filter((r) => r.access !== undefined && 'scope' in r.access)
      .map((r) => label(r.method, r.url));
    expect(violations).toEqual([]);
  });

  it('the registry is internally consistent', () => {
    expect(ALL_SCOPES.length).toBe(14);
    for (const s of ALL_SCOPES) expect(isScope(s)).toBe(true);
    expect(isScope('team:write')).toBe(false);
    expect(isScope('billing:both')).toBe(false);
    // write implies read
    expect([...expandScopes(['billing:write'])].sort()).toEqual(['billing:read', 'billing:write']);
    // unknown values are dropped on the READ path, never widened
    expect(expandScopes(['nope:write', 'billing:read']).size).toBe(1);
    // presets
    expect(presetScopes('APP_VIEWER').size).toBe(7);
    expect(presetScopes('APP_ADMIN').size).toBe(14);
    const billing = presetScopes('APP_BILLING');
    expect(billing.has('billing:write')).toBe(true);
    expect(billing.has('auth-config:read')).toBe(false);
    expect(billing.has('end-users:write')).toBe(false);
  });
});
