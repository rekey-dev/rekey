/**
 * `subscribeToList`: a server action that reads a form into a subscribe and
 * sends it with the secret key and the visitor's address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let requestHeaders = new Headers();
const subscribe = vi.fn();
const scopedWith: Array<string | undefined> = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => requestHeaders,
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@rekey.dev/node', async (importOriginal) => ({
  normalizeClientIp: (await importOriginal<typeof import('@rekey.dev/node')>()).normalizeClientIp,
  Rekey: class {
    lists = { subscribe };
    with(opts: { clientIp?: string }) {
      scopedWith.push(opts.clientIp);
      return this;
    }
  },
  RekeyError: class extends Error {
    constructor(args: { message: string; fix?: string }) {
      super(`${args.message} ${args.fix ?? ''}`);
    }
  },
}));

const server = await import('../src/server.js');

beforeEach(() => {
  subscribe.mockReset();
  subscribe.mockResolvedValue({ status: 'subscribed', contactId: 'c1' });
  scopedWith.length = 0;
  process.env.REKEY_SECRET = 'rp_test_x';
  process.env.REKEY_URL = 'https://api.test.invalid';
  delete process.env.REKEY_TRUSTED_PROXY_HOPS;
  requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.9', referer: 'https://acme.test/join?utm=x' });
});

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe('subscribeToList', () => {
  it('reads the form, keeps list fields apart, and sends the visitor address', async () => {
    const result = await server.subscribeToList(
      'waitlist',
      form({
        email: ' ada@example.com ',
        name: 'Ada',
        consent: 'on',
        consentVersion: '3',
        company: 'Engines',
        $ACTION_ID_abc: '',
        hp: '',
      }),
    );
    expect(result).toEqual({ status: 'received' });
    expect(scopedWith).toEqual(['203.0.113.9']);
    expect(subscribe.mock.calls[0]![2]).toEqual({ relay: 'browser' });
    expect(subscribe.mock.calls[0]![0]).toBe('waitlist');
    expect(subscribe.mock.calls[0]![1]).toEqual({
      email: 'ada@example.com',
      name: 'Ada',
      fields: { company: 'Engines' },
      consent: { granted: true, version: 3 },
      sourceUrl: 'https://acme.test/join?utm=x',
    });
  });

  it('sends no consent when the box is unticked, and passes a filled honeypot through', async () => {
    await server.subscribeToList('waitlist', form({ email: 'a@example.com', consentVersion: '1', hp: 'bot' }));
    expect(subscribe.mock.calls[0]![1]).toEqual({
      email: 'a@example.com',
      hp: 'bot',
      sourceUrl: 'https://acme.test/join?utm=x',
    });
  });

  it('takes a ready body as is, with an explicit visitor address', async () => {
    await server.subscribeToList('news', { email: 'b@example.com' }, { clientIp: '198.51.100.4' });
    expect(subscribe).toHaveBeenCalledWith('news', { email: 'b@example.com' }, { relay: 'browser' });
    expect(scopedWith).toEqual(['198.51.100.4']);
  });

  it('refuses to call without a visitor address, so the browser limits always apply', async () => {
    requestHeaders = new Headers({ host: 'app.example' });
    await expect(server.subscribeToList('news', { email: 'b@example.com' })).rejects.toThrow(/REKEY_TRUSTED_PROXY_HOPS/);
    await expect(server.subscribeToList('news', { email: 'b@example.com' }, { clientIp: null })).rejects.toThrow(/visitor/);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('refuses an address the SDK would drop, such as X-Forwarded-For: x', async () => {
    requestHeaders = new Headers({ 'x-forwarded-for': 'x' });
    await expect(server.subscribeToList('news', { email: 'b@example.com' })).rejects.toThrow(/visitor address/);
    await expect(server.subscribeToList('news', { email: 'b@example.com' }, { clientIp: '203.0.113.9:443' })).rejects.toThrow(
      /visitor address/,
    );
    expect(subscribe).not.toHaveBeenCalled();
  });
});
