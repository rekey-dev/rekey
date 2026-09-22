/**
 * Saves stay fresh without the blank page, and the Next runtime still behaves
 * the way that fix depends on.
 *
 * Two fixes collided here. July: `revalidatePath` plus `redirect` in one action
 * blanks the page for a round-trip (vercel/next.js#73317), so the panel dropped
 * `revalidatePath`. Later: `api()` called `revalidatePath` after every write to
 * keep data fresh, which put the blank page on every save. The resolution is no
 * revalidation in an action that redirects, plus a client refresh after an
 * action redirect lands. An action that returns a result instead (the one-time
 * secret mints) revalidates and does not redirect on that path. These tests pin
 * both halves, and read the installed Next so that an upgrade which moves the
 * ground under either one fails here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION_REDIRECT_HEADER, landedFromServerAction } from '../src/lib/action-landing';
import { serverActions } from './server-actions';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const nextDir = path.dirname(createRequire(import.meta.url).resolve('next/package.json'));

function nextFile(rel: string): string {
  return readFileSync(path.join(nextDir, 'dist', rel), 'utf8');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Source with comments removed, so explanatory prose does not count as a call. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('landedFromServerAction', () => {
  it('is true only when the redirect header is present', () => {
    expect(landedFromServerAction(new Headers({ [ACTION_REDIRECT_HEADER]: '/a?saved=1;push' }))).toBe(true);
    expect(landedFromServerAction(new Headers({ rsc: '1' }))).toBe(false);
  });
});

describe('panel source', () => {
  it('api() does not revalidate, because every caller redirects', () => {
    expect(code(path.join(srcDir, 'lib', 'api.ts'))).not.toMatch(/revalidate(Path|Tag)\s*\(/);
  });

  it('no action redirects once it has revalidated', () => {
    // An action may refuse with a redirect and succeed with a revalidation,
    // but the redirect has to come first: once `revalidatePath` has run, a
    // `redirect()` on the same path is the blank page. Checked in source
    // order, which is why the minting actions revalidate after their try/catch
    // rather than inside it.
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      for (const action of serverActions(readFileSync(file, 'utf8'))) {
        const revalidateAt = action.body.search(/revalidate(Path|Tag)\s*\(/);
        if (revalidateAt === -1) continue;
        if (/\bredirect\s*\(/.test(action.body.slice(revalidateAt))) {
          offenders.push(`${path.relative(srcDir, file)}:${action.line} ${action.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing outside a Server Action revalidates', () => {
    // A helper that revalidates can be called from an action that redirects,
    // which is the blank page again, one call away where the check above
    // cannot see it.
    const offenders = sourceFiles(srcDir).filter((f) => {
      const c = code(f);
      if (!/revalidate(Path|Tag)\s*\(/.test(c)) return false;
      const inActions = serverActions(readFileSync(f, 'utf8'))
        .map((a) => (a.body.match(/revalidate(Path|Tag)\s*\(/g) ?? []).length)
        .reduce((x, y) => x + y, 0);
      return (c.match(/revalidate(Path|Tag)\s*\(/g) ?? []).length !== inActions;
    });
    expect(offenders).toEqual([]);
  });

  it('the authed layout mounts the post-action refresh', () => {
    const layout = code(path.join(srcDir, 'app', '(authed)', 'layout.tsx'));
    expect(layout).toMatch(/landedFromServerAction\(/);
    expect(layout).toMatch(/<RefreshAfterAction\b/);
  });
});

describe('installed Next runtime', () => {
  it('only seeds the redirect target when the action did not revalidate', () => {
    const reducer = nextFile('client/components/router-reducer/reducers/server-action-reducer.js');
    // The blank page: without the seed, RedirectBoundary renders null until the
    // destination is fetched again.
    expect(reducer).toMatch(/!actionRevalidated\)\s*\{[\s\S]{0,1200}createSeededPrefetchCacheEntry/);
    // And the seed goes into the OLD prefetch cache, which is kept. This is why
    // other pages can be stale after a write, and why the refresh exists.
    expect(reducer).toMatch(/prefetchCache:\s*state\.prefetchCache[\s\S]{0,200}mutable\.prefetchCache = state\.prefetchCache/);
  });

  it('sets x-action-redirect before forwarding headers to the destination render', () => {
    const handler = nextFile('server/app-render/action-handler.js');
    const fn = handler.slice(handler.indexOf('async function createRedirectRenderResult'));
    const setAt = fn.indexOf(`res.setHeader('${ACTION_REDIRECT_HEADER}'`);
    const forwardAt = fn.indexOf('getForwardedHeaders(req, res)');
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(forwardAt).toBeGreaterThan(setAt);
  });

  it('a refresh empties the prefetch cache', () => {
    const refresh = nextFile('client/components/router-reducer/reducers/refresh-reducer.js');
    expect(refresh).toMatch(/mutable\.prefetchCache = new Map\(\)/);
  });
});
