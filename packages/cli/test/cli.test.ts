/**
 * CLI smoke tests, runs the compiled binary in subprocesses against a
 * stub HTTP server, verifying stdout/stderr/exit-code shape and the
 * --json contract.
 *
 * The stub server is the cheapest way to exercise the full CLI path
 * (commander parsing, env handling, fetch, output rendering) without
 * standing up a real Rekey API.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '..', 'dist', 'index.js');

// Read the expected version the same way the CLI does, rather than repeating
// it as a literal. A literal here is a second place to bump on every release,
// and it is exactly what let the CLI ship `0.0.0` for the whole 1.x line: the
// test asserted the stale constant, so it agreed with the bug.
const PKG_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
  entry: string = cliEntry,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn('node', [entry, ...args], {
      env: { ...process.env, ...env, REKEY_URL: '', SUPER_ADMIN_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

interface StubServer {
  url: string;
  close: () => Promise<void>;
  reset: () => void;
  setResponse: (path: string, status: number, body: unknown) => void;
  /**
   * Every request the CLI actually made, in order.
   *
   * Asserting on the WIRE, not on the exit code. A command that sends a field
   * the route silently discards still exits 0 and still prints a tick, which
   * is the whole defect this file now covers: the only place the difference is
   * visible is the request body.
   */
  requests: Array<{ key: string; body: unknown }>;
}

function startStubServer(): Promise<StubServer> {
  return new Promise((resolve) => {
    const responses = new Map<string, { status: number; body: unknown }>();
    const requests: Array<{ key: string; body: unknown }> = [];
    const server: Server = createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ key, body: raw === '' ? undefined : JSON.parse(raw) });
        const r = responses.get(key) ?? { status: 200, body: { success: true, data: {} } };
        res.statusCode = r.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.body));
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
        reset: () => {
          responses.clear();
          requests.length = 0;
        },
        setResponse: (key, status, body) => responses.set(key, { status, body }),
        requests,
      });
    });
  });
}

describe('rekey CLI', () => {
  let stub: StubServer;

  beforeAll(async () => {
    stub = await startStubServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  // ---------- version ----------

  it("rekey version → stdout: the package's own version, exit 0", async () => {
    const r = await runCli(['version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
    // Guard the failure this test previously encoded: a placeholder version is
    // never a correct answer, however it got there.
    expect(r.stdout.trim()).not.toBe('0.0.0');
  });

  it('rekey version --json → emits JSON', async () => {
    const r = await runCli(['version', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ version: PKG_VERSION });
  });

  // ---------- doctor ----------

  it('doctor without REKEY_URL fails with the right code', async () => {
    const r = await runCli(['doctor', '--json']);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      checks: Array<{ name: string; status: string; fix?: string }>;
    };
    expect(parsed.checks.find((c) => c.name === 'api-url')?.status).toBe('fail');
    expect(parsed.checks.find((c) => c.name === 'api-url')?.fix).toBeTruthy();
  });

  it('doctor reports ok when API responds 200 to /health', async () => {
    stub.reset();
    stub.setResponse('GET /health', 200, { status: 'ok', service: 'rekey-api' });
    const r = await runCli(['doctor', '--json'], {
      REKEY_URL: stub.url,
      SUPER_ADMIN_KEY: 'x'.repeat(40),
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { checks: Array<{ name: string; status: string }> };
    const named = Object.fromEntries(parsed.checks.map((c) => [c.name, c.status]));
    expect(named['api-url']).toBe('ok');
    expect(named['admin-key']).toBe('ok');
    expect(named['health']).toBe('ok');
  });

  // ---------- apps list ----------

  it('apps list returns the API\'s rows in JSON mode', async () => {
    stub.reset();
    stub.setResponse('GET /api/v1/admin/applications', 200, {
      success: true,
      // `{items, page}`, the list envelope every admin list endpoint returns.
      data: {
        items: [
          {
            id: 'app_1',
            tenantId: 'tn_1',
            name: 'A',
            slug: 'a',
            publicKey: 'rp_pub_a_xxx',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        page: { total: 1, limit: 50, offset: 0, hasMore: false },
      },
    });
    const r = await runCli(['apps', 'list', '--json'], {
      REKEY_URL: stub.url,
      SUPER_ADMIN_KEY: 'x'.repeat(40),
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { applications: Array<{ slug: string }> };
    expect(parsed.applications.map((a) => a.slug)).toEqual(['a']);
  });

  // ---------- error envelope passthrough ----------

  it('CLI surfaces RekeyError code/message/fix from the API to stderr', async () => {
    stub.reset();
    stub.setResponse('GET /api/v1/admin/applications', 401, {
      success: false,
      error: {
        code: 'ADMIN_AUTH_INVALID',
        message: 'The presented admin key does not match SUPER_ADMIN_KEY.',
        fix: 'Verify SUPER_ADMIN_KEY in your env.',
      },
    });
    const r = await runCli(['apps', 'list', '--json'], {
      REKEY_URL: stub.url,
      SUPER_ADMIN_KEY: 'wrongwrongwrongwrongwrongwrongwrongwrong',
    });
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stderr) as {
      success: false;
      error: { code: string; fix: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('ADMIN_AUTH_INVALID');
    expect(parsed.error.fix).toBeTruthy();
  });

  // ---------- secrets never reach --help ----------
  //
  // The global options used the environment as their commander DEFAULT, and
  // commander prints defaults in help, so `rekey --help` showed the live
  // SUPER_ADMIN_KEY to anyone who could read the terminal or a CI log.

  const SENTINEL = 'sentinel-xyz';

  it.each([[['--help']], [['apps', 'list', '--help']], [['plans', 'create', '--help']]])(
    '%j does not print the super-admin key or API URL from the environment',
    async (args) => {
      const r = await runCli(args, { SUPER_ADMIN_KEY: SENTINEL, REKEY_URL: 'https://sentinel-url.example' });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: rekey');
      expect(r.stdout + r.stderr).not.toContain(SENTINEL);
      expect(r.stdout + r.stderr).not.toContain('sentinel-url');
    },
  );

  it('commands still read the admin key and API URL from the environment', async () => {
    stub.reset();
    const r = await runCli(['apps', 'list', '--json'], { REKEY_URL: stub.url, SUPER_ADMIN_KEY: 'x'.repeat(40) });
    expect(r.code).toBe(0);
    expect(stub.requests.map((q) => q.key)).toEqual(['GET /api/v1/admin/applications']);
  });

  it('a flag still wins over the environment', async () => {
    stub.reset();
    const r = await runCli(['--api-url', stub.url, 'apps', 'list', '--json'], {
      REKEY_URL: 'http://127.0.0.1:1',
      SUPER_ADMIN_KEY: SENTINEL,
    });
    expect(r.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
  });

  // ---------- commander usage errors under --json ----------

  it.each([
    [['apps', 'list', '--bogus', '--json'], 'unknown option'],
    [['nope', '--json'], 'unknown command'],
    [['plans', 'create', '--json'], 'required option'],
    [['--json'], 'No command given'],
  ])('%j reports a usage error as the JSON envelope', async (args, fragment) => {
    const r = await runCli(args);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    const parsed = JSON.parse(r.stderr) as {
      success: boolean;
      error: { code: string; message: string; fix: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR');
    expect(parsed.error.message).toContain(fragment);
    expect(parsed.error.fix).toContain('--help');
  });

  it('usage errors without --json stay plain text', async () => {
    const r = await runCli(['apps', 'list', '--bogus']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown option '--bogus'");
    expect(r.stderr).not.toContain('CLI_USAGE_ERROR');
  });

  it.each([[['--help', '--json']], [['--version', '--json']]])('%j still exits 0', async (args) => {
    const r = await runCli(args);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).not.toBe('');
  });

  // ---------- --limit / --offset validation ----------

  it.each([
    ['--limit', '0', 'CLI_LIST_LIMIT_INVALID'],
    ['--limit', '101', 'CLI_LIST_LIMIT_INVALID'],
    ['--limit', '2.5', 'CLI_LIST_LIMIT_INVALID'],
    ['--limit', 'ten', 'CLI_LIST_LIMIT_INVALID'],
    ['--offset', '-1', 'CLI_LIST_OFFSET_INVALID'],
    ['--offset', '1.5', 'CLI_LIST_OFFSET_INVALID'],
  ])('apps list %s %s is refused before any request', async (flag, value, code) => {
    stub.reset();
    const r = await runCli(['apps', 'list', flag, value, '--json'], {
      REKEY_URL: stub.url,
      SUPER_ADMIN_KEY: 'x'.repeat(40),
    });
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.fix).toBeTruthy();
    expect(stub.requests).toEqual([]);
  });

  it('plans list validates --limit too', async () => {
    stub.reset();
    const r = await runCli(['plans', 'list', '--app', 'app_1', '--limit', '500', '--json'], {
      REKEY_URL: stub.url,
      SUPER_ADMIN_KEY: 'x'.repeat(40),
    });
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe('CLI_LIST_LIMIT_INVALID');
    expect(stub.requests).toEqual([]);
  });

  it('apps list forwards valid --limit and --offset', async () => {
    stub.reset();
    const r = await runCli(['apps', 'list', '--limit', '100', '--offset', '0', '--json'], {
      REKEY_URL: stub.url,
      SUPER_ADMIN_KEY: 'x'.repeat(40),
    });
    expect(r.code).toBe(0);
    expect(stub.requests.map((q) => q.key)).toEqual(['GET /api/v1/admin/applications?limit=100&offset=0']);
  });

  // ---------- plans create input validation ----------

  it('plans create rejects fractional --amount with a useful fix', async () => {
    const r = await runCli(
      [
        'plans',
        'create',
        '--app',
        'app_1',
        '--slug',
        'pro',
        '--name',
        'Pro',
        '--amount',
        '9.99',
        '--json',
      ],
      { REKEY_URL: stub.url, SUPER_ADMIN_KEY: 'x'.repeat(40) },
    );
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(parsed.error.code).toBe('CLI_PLANS_AMOUNT_INVALID');
    expect(parsed.error.fix).toContain('integer');
  });

  // ---------- plans create: flags this route cannot honour ----------
  //
  // `plans create` posts to the super-admin route, which builds SUBSCRIPTION
  // plans only. It used to send `kind`, `licenseKind`, `creditsAmount` and the
  // rest anyway; the route's schema dropped them and answered 201, so
  // `--kind LICENSE --credits-amount 500` printed a tick for a SUBSCRIPTION
  // plan. The CLI half of the fix is to refuse before the request is made.

  const PLAN_ARGS = ['plans', 'create', '--app', 'app_1', '--slug', 'pro', '--name', 'Pro', '--amount', '999'];
  const ENV = { REKEY_URL: '', SUPER_ADMIN_KEY: 'x'.repeat(40) };

  it.each([
    ['--kind', 'LICENSE'],
    ['--kind', 'CREDIT'],
    ['--license-kind', 'PERPETUAL'],
    ['--license-duration-days', '365'],
    ['--license-seats-allowed', '5'],
    ['--meter-slug', 'api_calls'],
    ['--price-per-unit-cents', '2'],
    ['--credits-amount', '500'],
  ])('plans create %s %s is refused before any request is sent', async (flag, value) => {
    stub.reset();
    const r = await runCli([...PLAN_ARGS, flag, value, '--json'], { ...ENV, REKEY_URL: stub.url });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stderr) as { error: { code: string; message: string; fix: string } };
    expect(parsed.error.code).toBe('CLI_PLANS_KIND_UNSUPPORTED');
    // The refusal has to say where the operation DOES work, or it is just a
    // dead end with a code attached.
    expect(parsed.error.fix).toContain('/api/v1/tenant/applications/:id/plans');
    expect(parsed.error.message).toContain(flag);

    // Nothing left the process. Before the fix this was a POST that came back
    // 201 for the wrong plan.
    expect(stub.requests).toEqual([]);
  });

  it('plans create sends only the fields the admin route implements', async () => {
    stub.reset();
    stub.setResponse('POST /api/v1/admin/applications/app_1/plans', 201, {
      success: true,
      data: {
        id: 'pl_1',
        applicationId: 'app_1',
        slug: 'pro',
        name: 'Pro',
        amount: 999,
        currency: 'USD',
        interval: 'MONTH',
        kind: 'SUBSCRIPTION',
        active: true,
      },
    });

    const r = await runCli([...PLAN_ARGS, '--json'], { ...ENV, REKEY_URL: stub.url });
    expect(r.code).toBe(0);

    const sent = stub.requests.find((q) => q.key === 'POST /api/v1/admin/applications/app_1/plans');
    expect(sent).toBeDefined();
    // `kind` included: the route is strict now, so sending even the correct
    // "SUBSCRIPTION" would be a 400 rather than a harmless no-op.
    expect(Object.keys(sent!.body as Record<string, unknown>).sort()).toEqual([
      'amount',
      'currency',
      'interval',
      'name',
      'slug',
    ]);
  });

  it('plans create --help does not advertise a flag that cannot work', async () => {
    const r = await runCli(['plans', 'create', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--amount');
    for (const flag of ['--license-kind', '--meter-slug', '--credits-amount']) {
      expect(r.stdout).not.toContain(flag);
    }
  });

  // ---------- apps create --environment ----------

  const APP_ARGS = ['apps', 'create', '--tenant', 'tn_1', '--name', 'A', '--slug', 'a'];

  function stubAppCreate(environment: string): void {
    stub.setResponse('POST /api/v1/admin/applications', 201, {
      success: true,
      data: {
        id: 'app_2',
        tenantId: 'tn_1',
        name: 'A',
        slug: 'a',
        publicKey: 'rp_pub_a_xxx',
        environment,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  }

  it('apps create sends --environment, so a PRODUCTION app is creatable', async () => {
    stub.reset();
    stubAppCreate('PRODUCTION');

    const r = await runCli([...APP_ARGS, '--environment', 'PRODUCTION', '--json'], {
      ...ENV,
      REKEY_URL: stub.url,
    });
    expect(r.code).toBe(0);

    const sent = stub.requests.find((q) => q.key === 'POST /api/v1/admin/applications');
    // The route has always accepted this field; the CLI never sent it, so
    // every app it created was DEVELOPMENT with an rp_test_ key.
    expect((sent!.body as { environment?: string }).environment).toBe('PRODUCTION');
  });

  it('apps create omits environment entirely when the flag is absent', async () => {
    stub.reset();
    stubAppCreate('DEVELOPMENT');

    const r = await runCli([...APP_ARGS, '--json'], { ...ENV, REKEY_URL: stub.url });
    expect(r.code).toBe(0);

    const sent = stub.requests.find((q) => q.key === 'POST /api/v1/admin/applications');
    // Not `environment: undefined`, and not a CLI-side default: the API owns
    // what "unspecified" means.
    expect(sent!.body as Record<string, unknown>).not.toHaveProperty('environment');
  });

  it('apps create rejects a value the API would not accept', async () => {
    stub.reset();
    const r = await runCli([...APP_ARGS, '--environment', 'prod', '--json'], {
      ...ENV,
      REKEY_URL: stub.url,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('CLI_APPS_ENVIRONMENT_INVALID');
    expect(parsed.error.message).toContain('PRODUCTION');
    expect(stub.requests).toEqual([]);
  });

  // ---------- init: the owner gets an invite, not just a label ----------

  const BOUND_INVITE = {
    id: 'oi_1',
    tenantId: 'tn_1',
    email: 'ops@acme.com',
    role: 'OWNER',
    expiresAt: '2026-10-05T00:00:00.000Z',
  };

  function stubInit(
    inviteUrl: string | null,
    opts: { invite?: Record<string, unknown>; mode?: string | null } = {},
  ): void {
    stub.reset();
    stub.setResponse('POST /api/v1/admin/tenants', 201, {
      success: true,
      data: { id: 'tn_1', name: 'Acme', ownerEmail: 'ops@acme.com' },
    });
    stub.setResponse('POST /api/v1/admin/operator-invites', 201, {
      success: true,
      data: {
        invite: opts.invite ?? BOUND_INVITE,
        rawToken: 'rp_opinv_secret',
        inviteUrl,
        warning: 'shown once',
      },
    });
    if (opts.mode === null) {
      stub.setResponse('GET /api/v1/tenant/auth/signup-mode', 404, { success: false });
    } else {
      stub.setResponse('GET /api/v1/tenant/auth/signup-mode', 200, {
        success: true,
        data: { mode: opts.mode ?? 'open' },
      });
    }
    stub.setResponse('DELETE /api/v1/admin/operator-invites/oi_1', 200, { success: true, data: {} });
    stub.setResponse('POST /api/v1/admin/applications', 201, {
      success: true,
      data: { id: 'app_1', slug: 'acme-prod', publicKey: 'rp_pub_x' },
    });
    stub.setResponse('POST /api/v1/admin/applications/app_1/api-keys', 201, {
      success: true,
      data: { apiKey: { id: 'k_1', keyPrefix: 'rp_test_ab' }, rawKey: 'rp_test_secret', warning: 'once' },
    });
  }

  const INIT_ARGS = [
    'init',
    '--tenant-name', 'Acme',
    '--owner-email', 'ops@acme.com',
    '--app-name', 'Acme Prod',
    '--app-slug', 'acme-prod',
  ];
  const INIT_ENV = () => ({ REKEY_URL: stub.url, SUPER_ADMIN_KEY: 'x'.repeat(40) });

  it('init mints an OWNER invite bound to the new tenant, before the app and key', async () => {
    stubInit('https://panel.acme.test/accept-invite?token=rp_opinv_secret');
    const r = await runCli([...INIT_ARGS, '--json'], INIT_ENV());
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.key)).toEqual([
      'POST /api/v1/admin/tenants',
      'POST /api/v1/admin/operator-invites',
      'GET /api/v1/tenant/auth/signup-mode',
      'POST /api/v1/admin/applications',
      'POST /api/v1/admin/applications/app_1/api-keys',
    ]);
    expect(stub.requests[1]!.body).toMatchObject({ tenantId: 'tn_1', email: 'ops@acme.com', role: 'OWNER' });
    const parsed = JSON.parse(r.stdout) as { ownerInvite: Record<string, unknown> };
    expect(parsed.ownerInvite).toMatchObject({
      email: 'ops@acme.com',
      role: 'OWNER',
      expiresAt: '2026-10-05T00:00:00.000Z',
      token: 'rp_opinv_secret',
      url: 'https://panel.acme.test/accept-invite?token=rp_opinv_secret',
      signupMode: 'open',
    });
    expect(parsed.ownerInvite.nextStep).toContain('Send the link to ops@acme.com');
  });

  it('init prints the invite link, its expiry and what to do next', async () => {
    stubInit('https://panel.acme.test/accept-invite?token=rp_opinv_secret');
    const r = await runCli(INIT_ARGS, INIT_ENV());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('https://panel.acme.test/accept-invite?token=rp_opinv_secret');
    expect(r.stdout).toContain('expires 2026-10-05T00:00:00.000Z');
    expect(r.stdout).toContain('Send the link to ops@acme.com');
    expect(r.stdout).toContain('create an account from the link');
    expect(r.stdout).not.toContain('Sign-up is closed');
  });

  it('init without PANEL_URL on the API still prints a usable path', async () => {
    stubInit(null);
    const r = await runCli(INIT_ARGS, INIT_ENV());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('<your panel URL>/accept-invite?token=rp_opinv_secret');
  });

  it('init in closed sign-up mode says only an existing account can accept', async () => {
    stubInit(null, { mode: 'closed' });
    const r = await runCli(INIT_ARGS, INIT_ENV());
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Sign-up is closed on this deployment');
    expect(r.stdout).toContain('only an existing account can accept');
    expect(r.stdout).not.toContain('create an account from the link');
  });

  it('init words the next step for every mode when the mode cannot be read', async () => {
    stubInit(null, { mode: null });
    const r = await runCli([...INIT_ARGS, '--json'], INIT_ENV());
    expect(r.code, r.stderr).toBe(0);
    const invite = (JSON.parse(r.stdout) as { ownerInvite: { signupMode: unknown; nextStep: string } }).ownerInvite;
    expect(invite.signupMode).toBeNull();
    expect(invite.nextStep).toContain('create an account from the link');
    expect(invite.nextStep).toContain('If sign-up is closed on this deployment, only an existing account can accept');
  });

  it('init refuses and revokes an invite an older API minted unbound, before any app or key', async () => {
    // What a pre-binding API answers: its mint schema drops tenantId/email/role.
    stubInit(null, {
      invite: { id: 'oi_1', tokenPrefix: 'rp_opinv_abc', expiresAt: null, status: 'active' },
    });
    const r = await runCli([...INIT_ARGS, '--json'], INIT_ENV());
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stderr) as { error: { code: string; message: string; fix: string } };
    expect(parsed.error.code).toBe('CLI_INVITE_UNBOUND');
    expect(parsed.error.message).toContain('The key was revoked');
    expect(parsed.error.fix).toContain('Upgrade the Rekey API to 2.2.0 or later');
    expect(parsed.error.fix).toContain('"tenantId": "tn_1"');
    expect(r.stdout).not.toContain('rp_opinv_secret');
    expect(stub.requests.map((q) => q.key)).toEqual([
      'POST /api/v1/admin/tenants',
      'POST /api/v1/admin/operator-invites',
      'DELETE /api/v1/admin/operator-invites/oi_1',
    ]);
  });

  it('init refuses an invite bound to some other tenant', async () => {
    stubInit(null, { invite: { ...BOUND_INVITE, tenantId: 'tn_other' } });
    const r = await runCli([...INIT_ARGS, '--json'], INIT_ENV());
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe('CLI_INVITE_UNBOUND');
  });
});

/**
 * The CLI also declares `main` / `types` / `exports`, so it is importable, and
 * it used to `program.parseAsync(process.argv)` at module scope. An importing
 * program had its OWN argv parsed by commander, which then printed help and
 * exited. Running is now gated on being the process entry point.
 */
describe('importing the package is inert', () => {
  function importInChild(source: string): Promise<RunResult> {
    return new Promise((resolve) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
        // A hostile argv: `--version` is a flag commander would have acted on.
        env: { ...process.env, REKEY_URL: '', SUPER_ADMIN_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }

  it('does not parse argv or exit when merely imported', async () => {
    const r = await importInChild(`
      const m = await import(${JSON.stringify(cliEntry)});
      console.log(typeof m.buildProgram === 'function' ? 'INERT' : 'MISSING_EXPORT');
    `);
    expect(r.stdout).toContain('INERT');
    expect(r.stdout).not.toContain('Usage: rekey');
    expect(r.code).toBe(0);
  });

  it('still exposes the assembled command tree to an importer', async () => {
    const r = await importInChild(`
      const { buildProgram } = await import(${JSON.stringify(cliEntry)});
      const names = buildProgram().commands.map((c) => c.name()).sort().join(',');
      console.log(names);
    `);
    expect(r.stdout.trim()).toContain('apps');
    expect(r.stdout.trim()).toContain('plans');
  });

  // npx and node_modules/.bin start the bin through a symlink. The old gate
  // compared argv[1] (the link) with import.meta.url (the real file), never
  // matched, and the CLI exited 0 having done nothing.
  it('runs when started through a symlink, as npx and node_modules/.bin do', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rekey-cli-bin-'));
    try {
      const link = path.join(dir, 'rekey');
      symlinkSync(cliEntry, link);
      const r = await runCli(['--help'], {}, link);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: rekey');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still runs normally when invoked as the binary', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
  });
});

describe('rekey lists', () => {
  let stub: StubServer;

  beforeAll(async () => {
    stub = await startStubServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  const member = (email: string, extra: Record<string, unknown> = {}) => ({
    contactId: `c_${email}`,
    email,
    name: null,
    status: 'subscribed',
    source: 'secret',
    consentVersion: 1,
    consentAt: '2026-09-29T00:00:00.000Z',
    subscribedAt: '2026-09-29T00:00:00.000Z',
    unsubscribedAt: null,
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...extra,
  });

  it('lists commands need an Application secret key, not the admin key', async () => {
    const r = await runCli(['lists', 'ls', '--json'], { REKEY_URL: stub.url, SUPER_ADMIN_KEY: 'x'.repeat(40), REKEY_SECRET: '' });
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe('CLI_SECRET_KEY_MISSING');
  });

  it('lists ls sends the secret key and prints the lists', async () => {
    stub.reset();
    stub.setResponse('GET /api/v1/lists', 200, {
      success: true,
      data: {
        items: [{ key: 'waitlist', name: 'Waitlist', kind: 'waitlist', publicCapture: true, archived: false, subscribed: 3, unsubscribed: 1 }],
        page: { total: 1, limit: 1, offset: 0, hasMore: false },
      },
    });
    const r = await runCli(['lists', 'ls', '--json'], { REKEY_URL: stub.url, REKEY_SECRET: 'rp_live_cli' });
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { lists: Array<{ key: string }> }).lists.map((l) => l.key)).toEqual(['waitlist']);
  });

  it('lists export follows cursors and writes CSV with formula cells defused', async () => {
    stub.reset();
    stub.setResponse('GET /api/v1/lists/waitlist/members?status=all&limit=500', 200, {
      success: true,
      data: { items: [member('a@example.com', { name: '=HYPERLINK("x")' })], nextCursor: 'NEXT' },
    });
    stub.setResponse('GET /api/v1/lists/waitlist/members?status=all&cursor=NEXT&limit=500', 200, {
      success: true,
      data: { items: [member('b@example.com', { name: 'Smith, Jo' })], nextCursor: null },
    });
    const r = await runCli(['lists', 'export', 'waitlist', '--status', 'all'], { REKEY_URL: stub.url, REKEY_SECRET: 'rp_live_cli' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'email,name,status,source,consentVersion,consentAt,subscribedAt,unsubscribedAt,updatedAt',
      `a@example.com,"'=HYPERLINK(""x"")",subscribed,secret,1,2026-09-29T00:00:00.000Z,2026-09-29T00:00:00.000Z,,2026-09-29T00:00:00.000Z`,
      `b@example.com,"Smith, Jo",subscribed,secret,1,2026-09-29T00:00:00.000Z,2026-09-29T00:00:00.000Z,,2026-09-29T00:00:00.000Z`,
    ]);
  });

  it('lists export --format jsonl --out writes the file and a JSON summary', async () => {
    stub.reset();
    stub.setResponse('GET /api/v1/lists/news/members?status=subscribed&limit=500', 200, {
      success: true,
      data: { items: [member('a@example.com')], nextCursor: null },
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'rekey-cli-export-'));
    try {
      const file = path.join(dir, 'news.jsonl');
      const r = await runCli(['lists', 'export', 'news', '--format', 'jsonl', '--out', file, '--json'], {
        REKEY_URL: stub.url,
        REKEY_SECRET: 'rp_live_cli',
      });
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ key: 'news', format: 'jsonl', status: 'subscribed', count: 1, file });
      expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({ email: 'a@example.com' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists export surfaces the API refusal with its fix', async () => {
    stub.reset();
    stub.setResponse('GET /api/v1/lists/news/members?status=subscribed&limit=500', 403, {
      success: false,
      error: { code: 'API_KEY_SCOPE_INSUFFICIENT', message: 'needs contacts:read', fix: 'Mint a key with contacts:read.' },
    });
    const r = await runCli(['lists', 'export', 'news', '--json'], { REKEY_URL: stub.url, REKEY_SECRET: 'rp_live_cli' });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      success: false,
      error: { code: 'API_KEY_SCOPE_INSUFFICIENT', message: 'needs contacts:read', fix: 'Mint a key with contacts:read.' },
    });
  });


  // ---------- analytics ----------

  it('analytics users needs an operator token', async () => {
    stub.reset();
    const r = await runCli(['analytics', 'users', '--app', 'app_1', '--json'], { REKEY_URL: stub.url, SUPER_ADMIN_KEY: 'x'.repeat(40) });
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(parsed.error.code).toBe('CLI_OPERATOR_TOKEN_MISSING');
    expect(parsed.error.fix).toContain('REKEY_OPERATOR_TOKEN');
    expect(stub.requests).toHaveLength(0);
  });

  it('analytics users forwards the flags as the query and prints the API data', async () => {
    stub.reset();
    const key = 'GET /api/v1/tenant/applications/app_1/analytics/users?range=7d&sections=kpis&platform=ios&createdVia=oauth';
    const data = {
      range: { from: '2026-09-24', to: '2026-09-30', days: 7, timezone: 'UTC' },
      sections: { kpis: { status: 'ok', source: 'live', timezone: 'UTC', data: { totalUsers: { value: 3 } } } },
    };
    stub.setResponse(key, 200, { success: true, data });
    const r = await runCli(
      ['analytics', 'users', '--app', 'app_1', '--range', '7d', '--sections', 'kpis', '--platform', 'ios', '--created-via', 'oauth', '--json'],
      { REKEY_URL: stub.url, REKEY_OPERATOR_TOKEN: 'rk_pat_test' },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.key)).toEqual([key]);
    expect(JSON.parse(r.stdout)).toEqual(data);
  });

  it('analytics users passes the API error code and fix through', async () => {
    stub.reset();
    stub.setResponse('GET /api/v1/tenant/applications/app_1/analytics/users?range=90d', 400, {
      success: false,
      error: { code: 'ANALYTICS_RANGE_TOO_LONG', message: 'too long', fix: 'Shorten the range to 63 days or less.' },
    });
    const r = await runCli(['analytics', 'users', '--app', 'app_1', '--range', '90d', '--json'], {
      REKEY_URL: stub.url,
      REKEY_OPERATOR_TOKEN: 'rk_pat_test',
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { code: 'ANALYTICS_RANGE_TOO_LONG', fix: 'Shorten the range to 63 days or less.' } });
  });
});
