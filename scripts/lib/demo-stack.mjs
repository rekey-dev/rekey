/**
 * Shared plumbing for the recorded walkthroughs.
 *
 * `scripts/record-panel-demo.mjs` (the operator-panel video) grew all of this
 * inline first; the two framework walkthroughs
 * (`record-nextjs-demo.mjs` / `record-nest-demo.mjs`) need the same scratch
 * stack, the same teardown guarantees and the same encoder settings, so it
 * lives here rather than being copied twice more.
 *
 * The contract every caller relies on:
 *   - the database is created for the run and dropped after it, always,
 *     including on SIGINT and on a thrown error;
 *   - every child process is spawned `detached` so teardown can kill the whole
 *     process group (`next dev`, `tsx` and `nest start` all fork workers that
 *     otherwise survive and hold the port);
 *   - nothing here reaches a deployed Rekey.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeLog(tag) {
  return (...a) => console.log(`[${tag}]`, ...a);
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------
export function psql(url, sql) {
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
}

/**
 * Drop + recreate the scratch database and apply migrations.
 *
 * `WITH (FORCE)` matters: a previous run that died mid-record can leave an idle
 * API connection behind, and a plain DROP would block on it forever rather than
 * failing loudly.
 */
export function resetDatabase({ adminUrl, dbName, databaseUrl, log }) {
  log(`resetting database ${dbName}`);
  psql(adminUrl, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
  psql(adminUrl, `CREATE DATABASE ${dbName};`);
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    { cwd: ROOT, stdio: 'pipe', env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
  log('migrations applied');
}

export function dropDatabase({ adminUrl, dbName, log }) {
  try {
    psql(adminUrl, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`);
    log(`dropped database ${dbName}`);
  } catch (e) {
    log('could not drop database:', e.message);
  }
}

export function flushRedis({ redisUrl, log }) {
  try {
    execFileSync('redis-cli', ['-u', redisUrl, 'FLUSHDB'], { stdio: 'pipe' });
  } catch {
    log('redis-cli FLUSHDB skipped');
  }
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------
export function createProcessGroup() {
  const children = [];
  const logs = new Map();

  /**
   * Spawn a long-lived server. Output is only echoed under DEMO_VERBOSE=1, but
   * it is always accumulated — `outputOf(name)` gives a recording script the
   * server's real boot banner to put on screen, instead of typing a plausible
   * one by hand.
   */
  function spawnBg(name, cmd, args, opts) {
    const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push({ name, child });
    logs.set(name, '');
    const tag = (buf) => {
      logs.set(name, logs.get(name) + String(buf));
      String(buf)
        .split('\n')
        .filter(Boolean)
        .forEach((l) => process.env.DEMO_VERBOSE && console.log(`  [${name}] ${l}`));
    };
    child.stdout.on('data', tag);
    child.stderr.on('data', tag);
    return child;
  }

  /** Everything a background process has printed so far. */
  const outputOf = (name) => logs.get(name) ?? '';

  function killAll() {
    for (const { child } of children) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    children.length = 0;
  }

  return { spawnBg, killAll, outputOf };
}

/**
 * Run a command to completion and capture its combined output.
 *
 * The walkthroughs really execute their scaffolding commands with this and
 * render the resulting text — so what is on screen is whatever the tool
 * actually printed on this run, not prose typed to look like output.
 */
export function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * Strip ANSI escapes and carriage-return progress redraws — the pane renders
 * as HTML, not a TTY, so a spinner that overwrote itself 400 times would
 * otherwise arrive as 400 separate lines.
 */
export const stripAnsi = (s) =>
  String(s)
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.split('\r').pop())
    .join('\n');

export async function waitFor(label, url, { timeoutMs = 180_000, expect } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        if (!expect) return;
        if (expect(await res.text())) return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${label} did not come up at ${url}`);
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
/**
 * Minimal client for the scratch API. Returns `{ status, json }` rather than
 * throwing so callers can assert the exact status they expect — every asserted
 * call in a recording script checks it, so a closing frame can never claim a
 * 200 that did not happen.
 */
export function makeApi(baseUrl) {
  return async function api(pathname, { method = 'GET', token, key, userToken, body } = {}) {
    const headers = {};
    // Only claim a JSON body when there is one. Fastify rejects an empty body
    // sent with `content-type: application/json` as a 400, which turned a
    // perfectly good DELETE into a mystery validation error.
    if (body) headers['content-type'] = 'application/json';
    if (token || key) headers.authorization = `Bearer ${token || key}`;
    if (userToken) headers['X-Rekey-User-Token'] = userToken;
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
}

/** API env that is safe to boot with: every secret below is generated per run. */
export function apiEnv({ databaseUrl, redisUrl, port }) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    NODE_ENV: 'development',
    PORT: String(port),
    HOST: '127.0.0.1',
    JWT_SECRET: 'demo-only-jwt-secret-regenerated-every-run-0001',
    SUPER_ADMIN_KEY: 'demo-only-super-admin-key-regenerated-every-run',
    ENCRYPTION_KEY: '0'.repeat(64),
    OPERATOR_SIGNUP_MODE: 'open',
    // The passwords in these scripts are fake, but the HIBP lookup is a network
    // call we do not want inside a recording run.
    HIBP_BREACH_CHECK_DISABLED: 'true',
  };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------
/**
 * webm → mp4 + poster. Same settings as the panel walkthrough so the three
 * videos on the site are one visual family and one size budget.
 *
 * `-crf 31` with `-preset veryslow` is what keeps a minute of 1280×800 under
 * ~600 KB; the content is flat UI and text, which x264 compresses extremely
 * well at a low frame rate.
 */
export function encode({ webmPath, mp4Path, posterPath, posterAtSeconds, log }) {
  mkdirSync(path.dirname(mp4Path), { recursive: true });
  log('encoding mp4');
  execFileSync(
    'ffmpeg',
    [
      '-y', '-i', webmPath,
      '-vf', 'fps=24,scale=1280:-2:flags=lanczos',
      '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0',
      '-pix_fmt', 'yuv420p', '-crf', '31', '-preset', 'veryslow',
      '-movflags', '+faststart', '-an', mp4Path,
    ],
    { stdio: 'pipe' },
  );
  log('encoding poster');
  execFileSync(
    'ffmpeg',
    ['-y', '-ss', String(posterAtSeconds), '-i', mp4Path, '-frames:v', '1', '-q:v', '4', posterPath],
    { stdio: 'pipe' },
  );
}

export function describeOutput(mp4Path) {
  const mb = (statSync(mp4Path).size / 1e6).toFixed(2);
  const dur = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', mp4Path,
  ]).toString().trim();
  return { mb, seconds: Number(dur).toFixed(1) };
}

export function requireBinaries(bins) {
  for (const bin of bins) {
    try {
      execFileSync('which', [bin], { stdio: 'pipe' });
    } catch {
      throw new Error(`${bin} not found on PATH`);
    }
  }
}
