/**
 * NOTE: `pnpm test` in this package builds first (`tsc && vitest run`), because
 * these cases import the built `dist/`. Turbo's `test` task depends on
 * `^build` — dependencies, not this package — so under `turbo run test` the
 * dist would be whatever a previous run left behind, and the suite passed
 * standalone while failing in CI. `@rekey.dev/node` hit this first and its
 * script carries the same guard.
 */
/**
 * Importing this package must not kill the importing process.
 *
 * `@rekey.dev/mcp` declares `main` / `types` / `exports`, so
 * `import '@rekey.dev/mcp'` resolves — but `dist/index.js` read the environment
 * and called `process.exit(1)` while the module was still evaluating. There is
 * no try/catch around a module's side effects, so an importer could not defend
 * against it: a test harness that wanted to list the tool schemas, or a wrapper
 * re-exporting them, simply died.
 *
 * These tests spawn a child process and import the BUILT artifact, because a
 * `process.exit` during module evaluation is exactly the failure a source-level
 * test cannot observe — the source-level test would take the process with it.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const distEntry = path.resolve(pkgRoot, 'dist', 'index.js');

/** Import the built entry in a child, with a deliberately EMPTY credential env. */
function importInChild(source: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    cwd: pkgRoot,
    env: {
      ...process.env,
      // The exact condition that used to exit(1) at module scope.
      REKEY_URL: '',
      SUPER_ADMIN_KEY: '',
      REKEY_OPERATOR_TOKEN: '',
    },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

describe('importing @rekey.dev/mcp is inert', () => {
  beforeAll(() => {
    if (!existsSync(distEntry)) {
      throw new Error('dist/ is missing — run `pnpm --filter @rekey.dev/mcp build` first.');
    }
  });

  it('does not exit the host process when required env is absent', () => {
    const r = importInChild(`
      await import(${JSON.stringify(distEntry)});
      console.log('SURVIVED');
    `);
    expect(r.stdout).toContain('SURVIVED');
    expect(r.status).toBe(0);
  });

  it('exposes the tool registry to an importer', () => {
    const r = importInChild(`
      const m = await import(${JSON.stringify(distEntry)});
      console.log(Array.isArray(m.tools) && m.tools.length > 0 ? 'TOOLS' : 'NONE');
    `);
    expect(r.stdout).toContain('TOOLS');
  });

  it('reports the missing-credential condition as a value, not an exit', () => {
    const r = importInChild(`
      const { createServer } = await import(${JSON.stringify(distEntry)});
      const built = createServer({});
      console.log(built.ok === false && built.message.includes('REKEY_URL') ? 'REPORTED' : 'UNEXPECTED');
    `);
    expect(r.stdout).toContain('REPORTED');
    expect(r.status).toBe(0);
  });

  it('still builds a server when the environment IS configured', () => {
    const r = importInChild(`
      const { createServer } = await import(${JSON.stringify(distEntry)});
      const built = createServer({ REKEY_URL: 'https://rekey.example.com', SUPER_ADMIN_KEY: 'sa_x' });
      console.log(built.ok ? 'BUILT' : 'FAILED: ' + built.message);
    `);
    expect(r.stdout).toContain('BUILT');
  });
});
