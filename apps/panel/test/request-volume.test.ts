/**
 * Request volume guards: what keeps one operator from spending the API's
 * shared rate limit by opening a page.
 *
 * Measured on a production build before these changes: the first load of an
 * end-user page fired 21 prefetch requests before any click, and `/applications`
 * with three applications turned five of its prefetches into
 * `GET /applications/:id` calls. Every authed full render also paid for
 * `creation-mode`, a deployment constant, in series after `me`.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/**
 * True when a source file gets at a `next/link` export other than the
 * `useLinkStatus` hook: a default or namespace import, a named import of
 * anything else, a re-export, a `require`, or a dynamic `import()`.
 */
function reachesNextLink(source: string): boolean {
  const from = String.raw`\s*['"]next/link['"]`;
  if (new RegExp(String.raw`\b(?:require|import)\s*\(` + from).test(source)) return true;
  if (new RegExp(String.raw`\bexport\b[^;]*?\bfrom` + from).test(source)) return true;
  const imports = source.matchAll(new RegExp(String.raw`\bimport\s+([^;]*?)\s+from` + from, 'g'));
  for (const m of imports) {
    const clause = (m[1] ?? '').trim();
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (!named) return true; // default, namespace, or default plus named
    const names = named[1]!.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.some((n) => n !== 'useLinkStatus' && n !== 'type useLinkStatus')) return true;
  }
  return false;
}

describe('links do not prefetch', () => {
  it('nothing reaches next/link except the wrapper (and useLinkStatus)', () => {
    const wrapper = path.join(srcDir, 'components', 'Link.tsx');
    const offenders = sourceFiles(srcDir).filter(
      (f) => f !== wrapper && reachesNextLink(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the guard catches every way of reaching next/link', () => {
    for (const bad of [
      "import Link from 'next/link';",
      'import NextLink, { useLinkStatus } from "next/link";',
      "import * as L from 'next/link';",
      "import { default as Link } from 'next/link';",
      "export { default } from 'next/link';",
      "export * from 'next/link';",
      "const Link = require('next/link');",
      "const Link = (await import('next/link')).default;",
    ]) {
      expect(reachesNextLink(bad), bad).toBe(true);
    }
    expect(reachesNextLink("import { useLinkStatus } from 'next/link';")).toBe(false);
    expect(reachesNextLink("import Link from '@/components/Link';")).toBe(false);
  });

  it('the wrapper defaults prefetch off and lets a caller opt back in', async () => {
    const { default: Link } = await import('../src/components/Link');
    expect(Link({ href: '/a' }).props.prefetch).toBe(false);
    expect(Link({ href: '/a', prefetch: true }).props.prefetch).toBe(true);
  });
});

describe('sub-tab switches have a loading boundary', () => {
  it.each([
    'app/(authed)/applications/[id]/end-users/[euid]/loading.tsx',
    'app/(authed)/applications/[id]/email/loading.tsx',
    'app/(authed)/account/loading.tsx',
  ])('%s exists', (rel) => {
    expect(existsSync(path.join(srcDir, rel))).toBe(true);
  });
});

describe('the authed layout', () => {
  it('fetches the operator and the creation mode in parallel', () => {
    const layout = readFileSync(path.join(srcDir, 'app', '(authed)', 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/Promise\.all\(\[\s*getMe\(\),\s*getWorkspaceCreationOpen\(\)\s*\]\)/);
  });
});

// ── creation-mode cache ────────────────────────────────────────────────────

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'access' }), set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  forbidden: () => {
    throw new Error('NEXT_FORBIDDEN');
  },
}));

describe('getWorkspaceCreationOpen', () => {
  let calls = 0;
  let reply: () => Response;

  beforeEach(() => {
    process.env.REKEY_URL = 'https://api.test';
    calls = 0;
    reply = () => new Response(JSON.stringify({ success: true, data: { mode: 'disabled' } }), { status: 200 });
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return reply();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('asks the API once, then answers from the cache across requests', async () => {
    const { getWorkspaceCreationOpen } = await import('@/lib/api');
    const t = 1_000_000;
    expect(await getWorkspaceCreationOpen(t)).toBe(false);
    expect(await getWorkspaceCreationOpen(t + 60_000)).toBe(false);
    expect(calls).toBe(1);
  });

  it('asks again once the cache has expired', async () => {
    const { getWorkspaceCreationOpen } = await import('@/lib/api');
    const t = 1_000_000;
    await getWorkspaceCreationOpen(t);
    await getWorkspaceCreationOpen(t + 6 * 60_000);
    expect(calls).toBe(2);
  });

  it('fails open and does not cache the failure', async () => {
    reply = () => new Response('{}', { status: 500 });
    const { getWorkspaceCreationOpen } = await import('@/lib/api');
    const t = 1_000_000;
    expect(await getWorkspaceCreationOpen(t)).toBe(true);
    reply = () => new Response(JSON.stringify({ success: true, data: { mode: 'disabled' } }), { status: 200 });
    expect(await getWorkspaceCreationOpen(t + 1)).toBe(false);
    expect(calls).toBe(2);
  });
});
