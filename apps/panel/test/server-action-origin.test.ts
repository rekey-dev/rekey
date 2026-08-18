/**
 * A malformed `Origin` must not be able to crash a Server Action.
 *
 * Next 15 does `new URL(req.headers['origin'])` guarded only by
 * `typeof === 'string'`. A browser sends the literal string "null" from an
 * opaque origin, which is a string, so the guard passes and the constructor
 * throws an uncaught `ERR_INVALID_URL`. Every action from that client answers
 * 500, and because the action never resolves, `useFormStatus().pending` never
 * clears — the submit button sits on "Saving…" until the operator reloads.
 *
 * Reproduced against the panel's OAuth provider form, where it presented as
 * "save does nothing and stays saving forever", and confirmed on a second,
 * unrelated page: it was never specific to either form.
 */

import { describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { sanitizedActionHeaders } from '../src/lib/server-action-origin';

/** Just enough of a NextRequest for the header read. */
function req(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe('sanitizedActionHeaders', () => {
  it('strips the literal string "null", which is what an opaque origin sends', () => {
    const headers = sanitizedActionHeaders(req({ origin: 'null', cookie: 'a=b' }));
    expect(headers, 'a malformed origin must be rewritten').not.toBeNull();
    expect(headers!.get('origin')).toBeNull();
    // Everything else survives. Dropping the cookie here would sign the
    // operator out rather than fix their save.
    expect(headers!.get('cookie')).toBe('a=b');
  });

  it('strips any other unparseable value', () => {
    for (const bad of ['undefined', 'not a url', '://', ' ']) {
      const headers = sanitizedActionHeaders(req({ origin: bad }));
      expect(headers, `expected "${bad}" to be stripped`).not.toBeNull();
      expect(headers!.get('origin')).toBeNull();
    }
  });

  it('leaves a real origin alone', () => {
    // The header is what Next compares against the forwarded host to stop
    // CSRF. Removing a VALID one would turn a request Next can attribute into
    // one it cannot, and defeat the check on every normal request.
    for (const good of ['https://panel.rekey.dev', 'http://localhost:3031']) {
      expect(sanitizedActionHeaders(req({ origin: good }))).toBeNull();
    }
  });

  it('leaves an absent origin alone', () => {
    // Next already treats a missing origin as an old browser: it warns and
    // proceeds. Nothing to repair.
    expect(sanitizedActionHeaders(req({}))).toBeNull();
  });
});
