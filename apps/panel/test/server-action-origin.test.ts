/**
 * A Server Action with a malformed `Origin` is refused, never run unchecked.
 *
 * Next 15 does `new URL(req.headers['origin'])` guarded only by
 * `typeof === 'string'`. A browser sends the literal string "null" from an
 * opaque origin, which is a string, so the guard passes and the constructor
 * throws an uncaught `ERR_INVALID_URL`: the action answers 500.
 *
 * Reproduced against the panel's OAuth provider form, where it presented as
 * "save does nothing and stays saving forever", and confirmed on a second,
 * unrelated page: it was never specific to either form.
 *
 * The first fix removed the header, but with no `Origin` Next skips its CSRF
 * origin check and runs the action. So the middleware answers 403 instead, as
 * exactly `text/plain`, which Next's action client turns into a rejected
 * action carrying the body as its message.
 */

import { describe, expect, it } from 'vitest';
import { rejectMalformedActionOrigin } from '../src/lib/server-action-origin';

function action(headers: Record<string, string>): { method: string; headers: Headers } {
  return { method: 'POST', headers: new Headers({ 'next-action': '7f3a9c', ...headers }) };
}

describe('rejectMalformedActionOrigin', () => {
  it('refuses the literal string "null", which is what an opaque origin sends', async () => {
    const res = rejectMalformedActionOrigin(action({ origin: 'null', cookie: 'a=b' }));
    expect(res, 'a malformed origin on an action must be refused').not.toBeNull();
    expect(res!.status).toBe(403);
    expect(res!.headers.get('content-type')).toBe('text/plain');
    expect(await res!.text()).toMatch(/opaque origin/);
  });

  it('refuses any other unparseable value', () => {
    for (const bad of ['undefined', 'not a url', '://', ' ']) {
      expect(rejectMalformedActionOrigin(action({ origin: bad }))?.status, bad).toBe(403);
    }
  });

  it('leaves a real origin to Next, same-site or cross-site', () => {
    // Next compares a valid origin with the forwarded host and rejects a
    // cross-origin action itself. Duplicating that here would drift from it.
    for (const good of ['https://panel.rekey.dev', 'http://localhost:3031', 'https://evil.example']) {
      expect(rejectMalformedActionOrigin(action({ origin: good }))).toBeNull();
    }
  });

  it('leaves an absent origin to Next', () => {
    // Next treats a missing origin as an old browser: it warns and proceeds.
    expect(rejectMalformedActionOrigin(action({}))).toBeNull();
  });

  it('leaves anything that is not a Server Action alone', () => {
    const page = { method: 'GET', headers: new Headers({ origin: 'null' }) };
    expect(rejectMalformedActionOrigin(page)).toBeNull();
    const post = { method: 'POST', headers: new Headers({ origin: 'null' }) };
    expect(rejectMalformedActionOrigin(post)).toBeNull();
  });
});
