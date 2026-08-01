/**
 * CLI smoke tests — runs the compiled binary in subprocesses against a
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
}

function startStubServer(): Promise<StubServer> {
  return new Promise((resolve) => {
    const responses = new Map<string, { status: number; body: unknown }>();
    const server: Server = createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      const r = responses.get(key) ?? { status: 200, body: { success: true, data: {} } };
      res.statusCode = r.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(r.body));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
        reset: () => responses.clear(),
        setResponse: (key, status, body) => responses.set(key, { status, body }),
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
      data: [
        {
          id: 'app_1',
          tenantId: 'tn_1',
          name: 'A',
          slug: 'a',
          publicKey: 'rp_pub_a_xxx',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
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
});
