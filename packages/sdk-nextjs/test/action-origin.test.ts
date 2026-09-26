/**
 * A Server Action with a malformed `Origin` is refused, never run unchecked.
 *
 * Next 15 does `new URL(req.headers['origin'])` guarded only by
 * `typeof === 'string'`, so the literal "null" an opaque origin sends (a
 * sandboxed iframe, a POST that crossed a cross-origin redirect) crashes the
 * action with a 500. Removing the header instead would be worse: with no
 * `Origin`, Next skips its origin-versus-host check and runs the action. So
 * `rekeyMiddleware` answers such an action 403 itself, as `text/plain` so
 * Next's action client rejects with the body as the message.
 *
 * Everything else must reach Next exactly as sent. `NextResponse.next()` with
 * no request override carries no `x-middleware-override-headers`, which is how
 * "untouched" is asserted below.
 */

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  MALFORMED_ACTION_ORIGIN_MESSAGE,
  rejectMalformedActionOrigin,
  rekeyMiddleware,
} from '../src/middleware.js';

/** A Server Action POST as Next's client sends it. */
function actionPost(path: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL(`https://app.example${path}`), {
    method: 'POST',
    headers: {
      'next-action': '7f3a9c',
      'content-type': 'text/plain;charset=UTF-8',
      ...headers,
    },
    body: '[]',
  });
}

function get(path: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL(`https://app.example${path}`), { headers });
}

/** True when middleware let the request through with no rewrite of its headers. */
function passedUntouched(res: Response): boolean {
  return (
    res.headers.get('x-middleware-next') === '1' &&
    res.headers.get('x-middleware-override-headers') === null
  );
}

async function expectRefused(res: Response | null): Promise<void> {
  expect(res, 'a malformed origin on an action must be refused').not.toBeNull();
  expect(res!.status).toBe(403);
  // Exactly `text/plain`: anything else and Next's client shows a generic message.
  expect(res!.headers.get('content-type')).toBe('text/plain');
  expect(res!.headers.get('x-middleware-next')).toBeNull();
  expect(await res!.text()).toBe(MALFORMED_ACTION_ORIGIN_MESSAGE);
}

describe('rejectMalformedActionOrigin', () => {
  it('refuses a Server Action from an opaque origin (Origin: null)', async () => {
    await expectRefused(rejectMalformedActionOrigin(actionPost('/', { origin: 'null' })));
  });

  it('refuses any other unparseable origin on a Server Action', async () => {
    for (const bad of ['undefined', 'not a url', '://', ' ', 'https://']) {
      await expectRefused(rejectMalformedActionOrigin(actionPost('/', { origin: bad })));
    }
  });

  it('lets a Server Action with a valid origin through, same-site or cross-site', () => {
    // Next compares a valid origin with the host and rejects a cross-origin
    // action itself, honouring `serverActions.allowedOrigins`. Not duplicated.
    for (const good of ['https://app.example', 'http://localhost:3000', 'https://evil.example']) {
      expect(rejectMalformedActionOrigin(actionPost('/', { origin: good }))).toBeNull();
    }
  });

  it('lets a Server Action with no origin through, as Next does', () => {
    expect(rejectMalformedActionOrigin(actionPost('/', {}))).toBeNull();
  });

  it('leaves a request that is not a Server Action alone, whatever its origin', () => {
    expect(rejectMalformedActionOrigin(get('/', { origin: 'null' }))).toBeNull();
    // A POST without `Next-Action` may be a route handler: Next never parses
    // its origin, so there is nothing to protect it from.
    const upload = new NextRequest(new URL('https://app.example/api/upload'), {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(rejectMalformedActionOrigin(upload)).toBeNull();
  });

  it('accepts a plain Request, not only a NextRequest', async () => {
    const req = new Request('https://app.example/', {
      method: 'POST',
      headers: { origin: 'null', 'next-action': 'abc' },
    });
    await expectRefused(rejectMalformedActionOrigin(req));
  });
});

describe('rekeyMiddleware applies the refusal by default', () => {
  const mw = rekeyMiddleware({ publicRoutes: ['/'], signInUrl: '/login' });

  it('refuses Origin: null on a Server Action to a public route', async () => {
    await expectRefused(mw(actionPost('/', { origin: 'null', cookie: 'a=b' })));
  });

  it('refuses Origin: null on a Server Action by a signed-in user', async () => {
    await expectRefused(mw(actionPost('/dashboard', { origin: 'null', cookie: 'rekey_access=tok' })));
  });

  it('refuses it ahead of the sign-in redirect', async () => {
    await expectRefused(mw(actionPost('/dashboard', { origin: 'null' })));
  });

  it('passes a same-origin Server Action through untouched', () => {
    expect(passedUntouched(mw(actionPost('/', { origin: 'https://app.example' })))).toBe(true);
  });

  it('passes a cross-origin Server Action through untouched, for Next to reject', () => {
    expect(passedUntouched(mw(actionPost('/', { origin: 'https://evil.example' })))).toBe(true);
  });

  it('passes a Server Action with no origin through untouched', () => {
    expect(passedUntouched(mw(actionPost('/', {})))).toBe(true);
  });

  it('never strips the origin: a page load with Origin: null reaches Next as sent', () => {
    expect(passedUntouched(mw(get('/', { origin: 'null' })))).toBe(true);
  });

  it('still redirects a signed-out user with a valid origin', () => {
    const res = mw(actionPost('/dashboard', { origin: 'https://app.example' }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });
});
