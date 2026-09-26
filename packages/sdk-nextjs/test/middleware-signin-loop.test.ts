/**
 * The gate must never protect the page it redirects to.
 *
 * The default `publicRoutes` does list `/sign-in`, so the out-of-the-box
 * configuration is fine, the original report overstated this. The loop is
 * real as soon as a caller supplies their own list, which *replaces* the
 * default rather than extending it: name a custom `signInUrl`, or simply
 * forget to include the sign-in path, and every request to it is redirected
 * to itself until the browser gives up.
 *
 * That is a plausible mistake rather than an exotic one, and the failure has
 * no error message attached, so the gate now treats `signInUrl` as public
 * whatever the caller passed.
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { rekeyMiddleware } from '../src/middleware.js';

const get = (path: string) => new NextRequest(new URL(`https://app.example${path}`));

describe('rekeyMiddleware', () => {
  it('never redirects the sign-in page to itself, even with a custom list', () => {
    const mw = rekeyMiddleware({ publicRoutes: ['/'], signInUrl: '/login' });
    const res = mw(get('/login'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('protects everything the caller did not list', () => {
    const mw = rekeyMiddleware({ publicRoutes: ['/'], signInUrl: '/login' });
    const res = mw(get('/dashboard'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });

  it('leaves a listed public route alone', () => {
    const mw = rekeyMiddleware({ publicRoutes: ['/'], signInUrl: '/login' });
    expect(mw(get('/')).status).toBe(200);
  });

  it('carries the attempted path so sign-in can return there', () => {
    const mw = rekeyMiddleware({ publicRoutes: ['/'] });
    const loc = new URL(mw(get('/dashboard')).headers.get('location')!);
    expect(loc.searchParams.get('next')).toBe('/dashboard');
  });

  it('lets a request with a session cookie through', () => {
    const req = get('/dashboard');
    req.cookies.set('rekey_access', 'token');
    expect(rekeyMiddleware({ publicRoutes: ['/'] })(req).status).toBe(200);
  });

  it('still ships auth pages as public by default', () => {
    const mw = rekeyMiddleware();
    for (const p of ['/sign-in', '/sign-up', '/forgot-password', '/reset-password']) {
      expect(mw(get(p)).status).toBe(200);
    }
  });
});

/**
 * A visitor holding a refresh token but no access token is stale, not signed
 * out, the access cookie lasts fifteen minutes against the refresh cookie's
 * thirty days, so this is every user, several times a day.
 *
 * They cannot be repaired by a page: refreshing writes cookies, which Next
 * forbids during a render, and spending a refresh token that cannot be stored
 * makes the API revoke every session the user has. The gate routes them
 * through a route handler, which may write.
 */
describe('stale session repair', () => {
  const withRefresh = (path: string) => {
    const req = get(path);
    req.cookies.set('rekey_refresh', 'r1');
    return req;
  };

  it('sends a stale visitor to the refresh route, remembering where they were', () => {
    const res = rekeyMiddleware()(withRefresh('/dashboard'));
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/api/rekey/refresh');
    expect(loc.searchParams.get('next')).toBe('/dashboard');
  });

  it('repairs on a public route too, since a public page may read the session', () => {
    const res = rekeyMiddleware({ publicRoutes: ['/'] })(withRefresh('/'));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/api/rekey/refresh');
  });

  it('never redirects the refresh route to itself', () => {
    const res = rekeyMiddleware()(withRefresh('/api/rekey/refresh'));
    expect(res.status).toBe(200);
  });

  it('leaves a signed-out visitor to the normal gate', () => {
    const res = rekeyMiddleware()(get('/dashboard'));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sign-in');
  });

  it('can be switched off', () => {
    const res = rekeyMiddleware({ refreshUrl: false })(withRefresh('/dashboard'));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sign-in');
  });

  it('honours a custom refresh route', () => {
    const res = rekeyMiddleware({ refreshUrl: '/session/renew' })(withRefresh('/dashboard'));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/session/renew');
  });

  it('sends a stale HEAD through the refresh route like a GET', () => {
    const req = new NextRequest(new URL('https://app.example/dashboard'), { method: 'HEAD' });
    req.cookies.set('rekey_refresh', 'r1');
    const res = rekeyMiddleware()(req);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/api/rekey/refresh');
  });

  // A Server Action POSTs to the page's own path. Redirecting it would lose the
  // submission (the refresh route answers GET only, so it was a 405), and the
  // action can refresh in place because it may write cookies.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'lets a stale %s through to refresh in place, on a protected route',
    (method) => {
      const req = new NextRequest(new URL('https://app.example/dashboard'), { method });
      req.cookies.set('rekey_refresh', 'r1');
      const res = rekeyMiddleware({ publicRoutes: ['/'] })(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    },
  );

  it('refuses a stale Server Action with Origin: null before letting it through', () => {
    // The Origin check runs ahead of the stale-session pass-through, so an
    // action from an opaque origin never reaches `auth()` and never rotates.
    const req = new NextRequest(new URL('https://app.example/dashboard'), {
      method: 'POST',
      headers: { origin: 'null', 'next-action': 'abc123' },
    });
    req.cookies.set('rekey_refresh', 'r1');
    const res = rekeyMiddleware()(req);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-middleware-next')).toBeNull();
  });

  it('lets a stale Server Action with a well-formed Origin through', () => {
    const req = new NextRequest(new URL('https://app.example/dashboard'), {
      method: 'POST',
      headers: { origin: 'https://app.example', 'next-action': 'abc123' },
    });
    req.cookies.set('rekey_refresh', 'r1');
    const res = rekeyMiddleware()(req);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('still sends a signed-out POST to sign-in', () => {
    const req = new NextRequest(new URL('https://app.example/dashboard'), { method: 'POST' });
    const res = rekeyMiddleware({ publicRoutes: ['/'] })(req);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sign-in');
  });

  it('with the hop switched off, a stale POST goes to sign-in as before', () => {
    const req = new NextRequest(new URL('https://app.example/dashboard'), { method: 'POST' });
    req.cookies.set('rekey_refresh', 'r1');
    const res = rekeyMiddleware({ refreshUrl: false, publicRoutes: ['/'] })(req);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/sign-in');
  });
});
