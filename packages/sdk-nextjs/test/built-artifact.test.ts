/**
 * Entrypoint isolation, checked against the BUILT `dist/`, not the source.
 *
 * The property: nothing a browser bundle can reach may lead to the module that
 * reads the Application secret key. `src/index.ts` states that intent in a
 * comment and `package.json` encodes it in `exports` — but until this file
 * existed, nothing failed if either drifted. A comment is not a guard, and
 * `exports` maps are edited by people fixing unrelated resolution bugs.
 *
 * Checked against `dist/` for the same reason `packages/sdk-node/test/
 * built-artifact.test.ts` is: what a consumer installs is the built output, and
 * a source-level test has already missed exactly this class of bug once in this
 * repo (a bare `require()` that every source test transpiled away and every npm
 * consumer hit). `tsc` emits one file per source module and rewrites nothing,
 * so the built import graph is the graph a bundler walks.
 *
 * NOT a claim that the barrel is browser-safe. It isn't, deliberately: the root
 * entry re-exports `./server.js` and `./middleware.js` and is a SERVER entry.
 * The claim is narrower and is the one that matters — `/client` and `/cookies`,
 * the two entries a `'use client'` component is documented to import, reach
 * neither the secret key nor `next/headers`.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const dist = path.join(pkgRoot, 'dist');

/** Every module specifier statically imported or re-exported by a built file. */
function specifiersOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
    // Strip comments — several of them name `REKEY_SECRET` and `./server.js`
    // while explaining precisely why those must not be reachable.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\s)(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]!);
  }
  // Bare side-effect imports: `import 'server-only';`
  for (const m of src.matchAll(/(?:^|\s)import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

/** Transitively resolve the local (relative) module graph from one entry. */
function localGraph(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) {
        external.add(spec);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec);
      if (existsSync(resolved)) queue.push(resolved);
    }
  }
  return { files, external };
}

const entries = {
  index: path.join(dist, 'index.js'),
  client: path.join(dist, 'client.js'),
  cookies: path.join(dist, 'cookies.js'),
  middleware: path.join(dist, 'middleware.js'),
  server: path.join(dist, 'server.js'),
};

describe('@rekey.dev/nextjs entrypoint isolation', () => {
  beforeAll(() => {
    for (const [name, file] of Object.entries(entries)) {
      if (!existsSync(file)) {
        throw new Error(
          `dist/${name}.js is missing — run \`pnpm --filter @rekey.dev/nextjs build\` first. ` +
            `These tests deliberately exercise the built output.`,
        );
      }
    }
  });

  it('server.js is the only module that reads the secret key', () => {
    // Pins WHERE the secret lives, so the reachability assertions below keep
    // meaning something if the read ever moves.
    const holders = Object.entries(entries).filter(([, f]) =>
      readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .includes('REKEY_SECRET'),
    );
    expect(holders.map(([n]) => n)).toEqual(['server']);
  });

  it('the client entry cannot reach the secret-key module', () => {
    // THE assertion. If someone re-exports a server helper from client.ts, or
    // adds a shared module that client.ts and server.ts both pull in, this goes
    // red before it reaches a browser bundle.
    const { files } = localGraph(entries.client);
    expect([...files].map((f) => path.basename(f))).not.toContain('server.js');
  });

  it('the client entry holds no secret-key reference of its own', () => {
    for (const file of localGraph(entries.client).files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${path.basename(file)} references REKEY_SECRET`).not.toContain('REKEY_SECRET');
    }
  });

  it('the client entry pulls in no Node-only or server-only Next module', () => {
    const { external } = localGraph(entries.client);
    for (const spec of external) {
      expect(spec.startsWith('node:'), `client reaches ${spec}`).toBe(false);
      expect(spec, 'client reaches a server-only Next module').not.toBe('next/headers');
      expect(spec).not.toBe('next/navigation');
    }
  });

  it("keeps the 'use client' directive as the first line of the built client entry", () => {
    // tsc emits the prologue verbatim; a build-tool change that drops it would
    // silently make the client entry a server module.
    expect(readFileSync(entries.client, 'utf8').split('\n')[0]!.trim()).toMatch(
      /^['"]use client['"];?$/,
    );
  });

  it('the cookies entry stays dependency-free', () => {
    // This entry exists so a client component can have the cookie names without
    // dragging the barrel — and therefore server.js — along. One import here
    // and that reason evaporates.
    const { files, external } = localGraph(entries.cookies);
    expect(files.size).toBe(1);
    expect([...external]).toEqual([]);
  });

  it('every exports subpath resolves to a file that exists', () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string> | string>;
    };
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue;
      for (const [condition, file] of Object.entries(target)) {
        expect(
          existsSync(path.join(pkgRoot, file)),
          `exports["${subpath}"].${condition} → ${file} does not exist`,
        ).toBe(true);
      }
    }
  });

  it('exposes both a client and a server entry — the split is load-bearing', () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    for (const subpath of ['.', './client', './server', './cookies', './middleware']) {
      expect(Object.keys(pkg.exports)).toContain(subpath);
    }
  });
});
