/**
 * The custom-domain lookup: answers are remembered for a bounded time and
 * count, made-up hosts cannot push out real ones or drive unbounded API
 * calls, and a failed lookup is never remembered.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWN_HOST_TTL_MS,
  MAX_REMEMBERED_HOSTS,
  MAX_UNKNOWN_LOOKUPS,
  UNKNOWN_HOST_TTL_MS,
  UNKNOWN_LOOKUP_WINDOW_MS,
  createHostResolver,
  lookupPortalHost,
  type HostAnswer,
} from '@/lib/host-resolver';

function harness(answers: Record<string, HostAnswer> = {}, maxUnknownLookups?: number) {
  let clock = 1_000_000;
  const asked: string[] = [];
  const resolve = createHostResolver(
    async (host) => {
      asked.push(host);
      return answers[host] ?? { kind: 'unknown' };
    },
    { now: () => clock, ...(maxUnknownLookups !== undefined && { maxUnknownLookups }) },
  );
  return { resolve, asked, answers, advance: (ms: number) => (clock += ms) };
}

const acme: HostAnswer = { kind: 'portal', slug: 'acme' };

describe('remembering answers', () => {
  it('remembers a known host until its TTL passes, then asks again', async () => {
    const h = harness({ 'billing.acme.test': acme });
    expect(await h.resolve('billing.acme.test')).toEqual(acme);
    h.advance(KNOWN_HOST_TTL_MS - 1);
    await h.resolve('billing.acme.test');
    expect(h.asked).toHaveLength(1);
    h.advance(1);
    await h.resolve('billing.acme.test');
    expect(h.asked).toHaveLength(2);
  });

  it('stops serving a domain that lapsed once the TTL passes', async () => {
    const h = harness({ 'billing.acme.test': acme });
    await h.resolve('billing.acme.test');
    h.answers['billing.acme.test'] = { kind: 'unknown' };
    h.advance(KNOWN_HOST_TTL_MS);
    expect(await h.resolve('billing.acme.test')).toEqual({ kind: 'unknown' });
  });

  it('remembers an unknown host until its TTL passes', async () => {
    const h = harness();
    await h.resolve('nobody.example.org');
    h.advance(UNKNOWN_HOST_TTL_MS - 1);
    await h.resolve('nobody.example.org');
    expect(h.asked).toHaveLength(1);
    h.advance(1);
    await h.resolve('nobody.example.org');
    expect(h.asked).toHaveLength(2);
  });

  it('never remembers an unavailable answer', async () => {
    const h = harness({ 'billing.acme.test': { kind: 'unavailable' } });
    await h.resolve('billing.acme.test');
    await h.resolve('billing.acme.test');
    expect(h.asked).toHaveLength(2);
  });

  it('shares one lookup between concurrent requests for a host', async () => {
    const h = harness({ 'billing.acme.test': acme });
    await Promise.all([h.resolve('billing.acme.test'), h.resolve('billing.acme.test'), h.resolve('billing.acme.test')]);
    expect(h.asked).toHaveLength(1);
  });

  it('reads a lookup that throws as unavailable', async () => {
    const resolve = createHostResolver(async () => {
      throw new Error('boom');
    });
    expect(await resolve('billing.acme.test')).toEqual({ kind: 'unavailable' });
  });
});

describe('bounds', () => {
  function manyKnown(count: number): Record<string, HostAnswer> {
    const answers: Record<string, HostAnswer> = {};
    for (let i = 0; i < count; i++) answers[`k${i}.acme.test`] = acme;
    return answers;
  }

  it('holds at most the bound of hosts, forgetting the oldest', async () => {
    const h = harness(manyKnown(MAX_REMEMBERED_HOSTS + 1), Infinity);
    for (let i = 0; i <= MAX_REMEMBERED_HOSTS; i++) await h.resolve(`k${i}.acme.test`);
    const before = h.asked.length;
    await h.resolve(`k${MAX_REMEMBERED_HOSTS}.acme.test`);
    expect(h.asked.length).toBe(before);
    await h.resolve('k0.acme.test');
    expect(h.asked.length).toBe(before + 1);
  });

  it('never lets an unknown host push out a known one', async () => {
    const h = harness(manyKnown(MAX_REMEMBERED_HOSTS), Infinity);
    for (let i = 0; i < MAX_REMEMBERED_HOSTS; i++) await h.resolve(`k${i}.acme.test`);
    await h.resolve('made-up.example.org');
    h.asked.length = 0;
    expect(await h.resolve('k0.acme.test')).toEqual(acme);
    expect(h.asked).toEqual([]);
  });

  it('caps lookups of hosts not known to serve a portal per window', async () => {
    const h = harness();
    for (let i = 0; i < MAX_UNKNOWN_LOOKUPS; i++) await h.resolve(`made${i}.example.org`);
    expect(await h.resolve('one-more.example.org')).toEqual({ kind: 'unavailable' });
    expect(h.asked).toHaveLength(MAX_UNKNOWN_LOOKUPS);
    h.advance(UNKNOWN_LOOKUP_WINDOW_MS);
    await h.resolve('one-more.example.org');
    expect(h.asked).toHaveLength(MAX_UNKNOWN_LOOKUPS + 1);
  });

  it('still refreshes a known host while the cap is spent', async () => {
    const h = harness({ 'billing.acme.test': acme });
    await h.resolve('billing.acme.test');
    for (let i = 0; i < MAX_UNKNOWN_LOOKUPS; i++) await h.resolve(`made${i}.example.org`);
    h.advance(KNOWN_HOST_TTL_MS);
    for (let i = 0; i < MAX_UNKNOWN_LOOKUPS - 1; i++) await h.resolve(`again${i}.example.org`);
    expect(await h.resolve('billing.acme.test')).toEqual(acme);
  });
});

describe('lookupPortalHost', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(res: () => Response) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return res();
    });
    return calls;
  }

  it('asks the config-by-host route with the host encoded', async () => {
    const calls = stub(() => Response.json({ success: true, data: { slug: 'acme' } }));
    expect(await lookupPortalHost('http://api.internal:3030/', 'billing.acme.test')).toEqual(acme);
    expect(calls).toEqual(['http://api.internal:3030/api/v1/portal/config?host=billing.acme.test']);
  });

  it('reads 404 as unknown and anything else that is not a plain slug as unavailable', async () => {
    stub(() => new Response('', { status: 404 }));
    expect(await lookupPortalHost('http://api', 'a.test')).toEqual({ kind: 'unknown' });
    stub(() => new Response('', { status: 429 }));
    expect(await lookupPortalHost('http://api', 'a.test')).toEqual({ kind: 'unavailable' });
    stub(() => Response.json({ data: { slug: '../evil' } }));
    expect(await lookupPortalHost('http://api', 'a.test')).toEqual({ kind: 'unavailable' });
    stub(() => new Response('not json'));
    expect(await lookupPortalHost('http://api', 'a.test')).toEqual({ kind: 'unavailable' });
    expect(await lookupPortalHost(undefined, 'a.test')).toEqual({ kind: 'unavailable' });
  });
});
