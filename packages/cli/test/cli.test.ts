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

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn('node', [cliEntry, ...args], {
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

  it('still runs normally when invoked as the binary', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
  });
});
