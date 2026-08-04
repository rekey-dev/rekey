/**
 * Helpers shared by the two framework walkthroughs: building installable SDK
 * tarballs out of this repository, and writing the demo project's files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './demo-stack.mjs';

/** What the prompt and the editor title bar show. Cosmetic; the real project
 *  lives under a temp directory that is deleted after the run. */
export const PROMPT = '~/northwind';

/**
 * Build installable tarballs for the SDK packages out of this repository and
 * return their absolute paths.
 *
 * `pnpm pack` (not `npm pack`) because it rewrites `workspace:^` dependency
 * ranges to real versions — an `npm pack` tarball installs with
 * `EUNSUPPORTEDPROTOCOL`.
 *
 * WHY LOCAL TARBALLS RATHER THAN THE REGISTRY. The same reason the panel
 * walkthrough boots this repository's API instead of api.rekey.dev: a video
 * that films `main` cannot advertise a product that no longer looks like that.
 * It also matters concretely right now — the packages published to npm are
 * behind this repository, in ways that break exactly what these videos show:
 *
 *   - `@rekey.dev/node`'s published `exports` map has only `types` and
 *     `import` — no `require`, no `default` — so it cannot be loaded from a
 *     CommonJS project at all. `nest new` scaffolds CommonJS. The fix (a
 *     `default` condition) is in this repository and unreleased.
 *   - `@rekey.dev/nextjs`'s published `exports` has no `./cookies` entry,
 *     though the README documents it as the entry Client Components must use.
 *
 * Both are release-pipeline problems, not code problems, and both are fixed on
 * `main`. Packing from source is what makes these walkthroughs reproducible in
 * the meantime.
 */
/**
 * Where the walkthroughs get their SDKs from.
 *
 *   repo     — tarballs packed from this repository (default).
 *   registry — plain `npm i @rekey.dev/…` against the real npm registry.
 *
 * `registry` is what these videos SHOULD show, and what they will show as soon
 * as the two release-pipeline bugs described on `packSdks` are published. It is
 * one environment variable rather than a rewrite precisely so that switching
 * back is trivial:
 *
 *   DEMO_SDK_SOURCE=registry pnpm demo:record:nextjs
 *
 * The Next.js walkthrough already passes on `registry` today. The Nest one does
 * not, and fails loudly at boot rather than recording something misleading.
 */
export const SDK_SOURCE = process.env.DEMO_SDK_SOURCE === 'registry' ? 'registry' : 'repo';

/**
 * Stage the SDKs into the project and return { args, shown } —
 * `args` is what npm is really invoked with, `shown` is what the recording
 * types. They describe the same command: `args` are the paths relative to the
 * project directory, which is also npm's cwd.
 */
export function stageSdks({ projectDir, tarballs, packageNames }) {
  if (SDK_SOURCE === 'registry') {
    const spec = packageNames.join(' ');
    return { args: packageNames, shown: `npm i ${spec}` };
  }
  // Copy the tarballs INTO the project so the command that appears on screen is
  // short enough to read and is literally the command that runs.
  const dest = path.join(projectDir, '.rekey-packs');
  mkdirSync(dest, { recursive: true });
  const rel = [];
  for (const t of tarballs) {
    const name = path.basename(t);
    copyFileSync(t, path.join(dest, name));
    rel.push(path.join('.rekey-packs', name));
  }
  return { args: rel, shown: `npm i ${rel.join(' ')}` };
}

export function packSdks(outDir, packages, log) {
  if (SDK_SOURCE === 'registry') {
    log('DEMO_SDK_SOURCE=registry — installing from npm, not from this repo');
    return [];
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  log(`packing ${packages.length} SDK packages from this repository`);
  for (const pkg of packages) {
    execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
      cwd: path.join(ROOT, 'packages', pkg),
      stdio: 'pipe',
    });
  }
  const tarballs = readdirSync(outDir)
    .filter((n) => n.endsWith('.tgz'))
    .map((n) => path.join(outDir, n));
  if (tarballs.length !== packages.length) {
    throw new Error(`expected ${packages.length} tarballs, got ${tarballs.length}`);
  }
  return tarballs;
}

/** Write a `{ relativePath: contents }` map into the project, creating dirs. */
export function writeProject(projectDir, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(projectDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}
