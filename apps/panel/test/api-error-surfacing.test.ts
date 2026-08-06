/**
 * The panel must not replace an answer with a shrug, and must not let a link
 * put words in its own mouth.
 *
 * A workspace at its application limit gets a precise sentence from the API —
 * which limit, the current count, which environments are exempt. The panel kept
 * a per-page map of code → sentence and rendered "Something went wrong. Please
 * try again." for anything it did not recognise, so that sentence never reached
 * the operator (#375). The same defect showed externally as rekey-dev/rekey#19,
 * where an unmapped code rendered no banner at all.
 *
 * The first fix carried the message in the query string. That was wrong for a
 * different reason: a query parameter is written by whoever composes the link,
 * so it handed anyone who could get an operator to click a URL the ability to
 * render arbitrary text inside the panel's own authenticated error banner. The
 * message travels in a short-lived httpOnly cookie now, and these tests pin
 * both properties.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string) => void jar.set(name, value));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: cookieSet,
  }),
  headers: async () => new Headers(),
}));
vi.mock('../src/lib/cookie-secure', () => ({ cookieSecure: async () => true }));

const { errorQuery, readErrorFlash, PanelApiError } = await import('../src/lib/api');

const LIMIT_MESSAGE =
  'This workspace has reached its limit of 1 production application (currently 1). ' +
  'Applications in the staging and development environments are not counted and can still be created.';

const err = (code: string, message: string, fix?: string) =>
  new PanelApiError({ code, message, statusCode: 400, ...(fix ? { fix } : {}) });

beforeEach(() => {
  jar.clear();
  cookieSet.mockClear();
});

describe('the prose never enters the URL', () => {
  it('puts only the code and the caller extras in the query string', async () => {
    const q = new URLSearchParams(
      await errorQuery(err('APPLICATION_LIMIT_REACHED', LIMIT_MESSAGE, 'Upgrade the plan.'), {
        newApp: '1',
      }),
    );
    expect(q.get('error')).toBe('APPLICATION_LIMIT_REACHED');
    expect(q.get('newApp')).toBe('1');
    // The two that would otherwise be attacker-writable, and would land in
    // history and the Referer of the next outbound link.
    expect(q.has('detail')).toBe(false);
    expect(q.has('fix')).toBe(false);
  });

  it('writes the message to an httpOnly, same-site, short-lived cookie', async () => {
    await errorQuery(err('X', 'boom', 'do this'));
    const [, , opts] = cookieSet.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('strict');
    expect(opts.secure).toBe(true);
    expect(opts.maxAge).toBeLessThanOrEqual(60);
  });

  it('caps what it stores, because a hostile API is still a bound worth having', async () => {
    await errorQuery(err('X', 'm'.repeat(1000), 'f'.repeat(1000)));
    const flash = await readErrorFlash('X');
    expect(flash.detail).toHaveLength(300);
    expect(flash.fix).toHaveLength(300);
  });
});

describe('reading the flash back', () => {
  it('returns the message for the code it was written for', async () => {
    await errorQuery(err('APPLICATION_LIMIT_REACHED', LIMIT_MESSAGE, 'Upgrade the plan.'));
    expect(await readErrorFlash('APPLICATION_LIMIT_REACHED')).toEqual({
      detail: LIMIT_MESSAGE,
      fix: 'Upgrade the plan.',
    });
  });

  it('refuses to attach a stale message to a different failure', async () => {
    await errorQuery(err('RATE_LIMITED', 'slow down'));
    expect(await readErrorFlash('NAME_TAKEN')).toEqual({});
  });

  it('is empty with no cookie, no code, or a corrupt cookie', async () => {
    expect(await readErrorFlash('X')).toEqual({});
    expect(await readErrorFlash(undefined)).toEqual({});
    jar.set('rk_err', 'not json');
    expect(await readErrorFlash('X')).toEqual({});
  });
});
