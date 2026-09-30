/**
 * Load test for GET /api/v1/tenant/applications/:id/analytics/users.
 *
 *   node load-analytics.mjs setup   # operators + one app, writes perf-state.json
 *   node load-analytics.mjs run     # the cases below, prints p50/p95/p99 per case
 *
 * Env: PERF_API_URL (default http://127.0.0.1:3990), PERF_REDIS_URL (to flush
 * the analytics cache for the cold cases), PERF_OPERATORS (default 20),
 * PERF_SECONDS per case (default 60), PERF_STATE (default ./perf-state.json),
 * PERF_CASES (comma list of case indexes to run; default all).
 *
 * The route allows 120 requests a minute per operator per Application and 30
 * uncached section computations, so each operator paces itself under both:
 * one request per 0.5 s, and in the cold cases one per 2 s per section asked
 * for. The latency distribution is what is measured, not throughput.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const API = process.env.PERF_API_URL ?? 'http://127.0.0.1:3990';
const OPERATORS = Number(process.env.PERF_OPERATORS ?? 20);
const SECONDS = Number(process.env.PERF_SECONDS ?? 60);
const STATE = process.env.PERF_STATE ?? './perf-state.json';
const REQUEST_PACE_MS = 500;
const COMPUTE_PACE_MS = 2_000;

async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function setup() {
  const tag = Math.random().toString(36).slice(2, 8);
  const owner = await call('POST', '/api/v1/tenant/auth/sign-up', null, {
    email: `perf-owner-${tag}@example.com`,
    password: 'pw-one-two-three',
    workspaceName: 'Perf',
  });
  const ownerToken = owner.json.data.accessToken;
  const app = await call('POST', '/api/v1/tenant/applications', ownerToken, { name: 'Perf', slug: `perf-${tag}` });
  const appId = app.json.data.id;
  const tenantId = app.json.data.tenantId;
  const tokens = [ownerToken];
  const emails = [`perf-owner-${tag}@example.com`];
  for (let i = 1; i < OPERATORS; i++) {
    const email = `perf-op-${i}-${tag}@example.com`;
    const su = await call('POST', '/api/v1/tenant/auth/sign-up', null, { email, password: 'pw-one-two-three', workspaceName: `Own ${i}` });
    const inv = await call('POST', '/api/v1/tenant/workspace/invitations', ownerToken, { email, role: 'ADMIN' });
    const acc = await call('POST', '/api/v1/tenant/invitations/accept', su.json.data.accessToken, { token: inv.json.data.token });
    tokens.push(acc.json.data.accessToken);
    emails.push(email);
  }
  await writeFile(STATE, JSON.stringify({ appId, tenantId, emails }, null, 2));
  console.log(JSON.stringify({ appId, tenantId, operators: tokens.length }));
}

async function flushAnalyticsCache() {
  if (!process.env.PERF_REDIS_URL) return;
  const { Redis } = await import('ioredis');
  const redis = new Redis(process.env.PERF_REDIS_URL);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'rk:an:*', 'COUNT', 1000);
    if (keys.length) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
  await redis.quit();
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

async function runCase(state, name, query, { cold }) {
  const sections = (new URLSearchParams(query).get('sections') ?? '').split(',').filter(Boolean).length || 8;
  const PACE_MS = cold ? COMPUTE_PACE_MS * sections : REQUEST_PACE_MS;
  const latencies = [];
  const statuses = {};
  const sectionStatuses = {};
  const deadline = Date.now() + SECONDS * 1000;
  await Promise.all(
    state.tokens.map(async (token, i) => {
      await new Promise((r) => setTimeout(r, (i * PACE_MS) / state.tokens.length));
      while (Date.now() < deadline) {
        if (cold) await flushAnalyticsCache();
        const started = performance.now();
        const res = await call('GET', `/api/v1/tenant/applications/${state.appId}/analytics/users${query}`, token);
        const ms = performance.now() - started;
        if (res.status === 200) latencies.push(ms);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        for (const s of Object.values(res.json?.data?.sections ?? {})) {
          sectionStatuses[s.status] = (sectionStatuses[s.status] ?? 0) + 1;
        }
        const wait = PACE_MS - ms;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  return { name, query, cold, n: latencies.length, p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), max: pct(latencies, 100), statuses, sectionStatuses };
}

/** Fresh access tokens, signed into the perf workspace: the setup's expire in minutes. */
async function signIn(state) {
  const tokens = [];
  for (const email of state.emails) {
    const res = await call('POST', '/api/v1/tenant/auth/sign-in', null, { email, password: 'pw-one-two-three' });
    const sw = await call('POST', '/api/v1/tenant/auth/switch-workspace', res.json.data.accessToken, { tenantId: state.tenantId });
    tokens.push(sw.json.data?.accessToken ?? res.json.data.accessToken);
  }
  return tokens;
}

async function run() {
  const state = JSON.parse(await readFile(STATE, 'utf8'));
  const cases = [
    ['A: kpis,activity 30d, cold', '?range=30d&sections=kpis,activity', true],
    ['B: rest 30d, cold', '?range=30d&sections=mix,onboarding,retention,security,billing,usage', true],
    ['A: kpis,activity 30d, warm', '?range=30d&sections=kpis,activity', false],
    ['rollup: 366d kpis,activity, cold', `?range=12m&sections=kpis,activity`, true],
    ['live A: kpis,activity 30d (verified=true forces live), cold', '?range=30d&sections=kpis,activity&verified=true', true],
    ['worst live multi-filter 63d, cold', '?range=custom&from=__FROM__&to=__TO__&sections=kpis,activity,mix,onboarding&platform=ios,web&country=DE&verified=true&onboarding=completed', true],
  ];
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 62 * 86_400_000).toISOString().slice(0, 10);
  const only = process.env.PERF_CASES ? new Set(process.env.PERF_CASES.split(',').map(Number)) : null;
  const results = [];
  for (const [index, [name, q, cold]] of cases.entries()) {
    if (only && !only.has(index)) continue;
    const tokens = await signIn(state);
    const r = await runCase({ ...state, tokens }, name, q.replace('__FROM__', from).replace('__TO__', today), { cold });
    console.log(JSON.stringify(r));
    results.push(r);
  }
  await writeFile(STATE.replace(/\.json$/, `-results-${Date.now()}.json`), JSON.stringify(results, null, 2));
}

const mode = process.argv[2];
if (mode === 'setup') await setup();
else if (mode === 'run') await run();
else {
  console.error('usage: node load-analytics.mjs setup|run');
  process.exitCode = 1;
}
