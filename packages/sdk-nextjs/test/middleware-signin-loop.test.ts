/**
 * The gate must never protect the page it redirects to.
 *
 * The default `publicRoutes` does list `/sign-in`, so the out-of-the-box
 * configuration is fine — the original report overstated this. The loop is
 * real as soon as a caller supplies their own list, which *replaces* the
 * default rather than extending it: name a custom `signInUrl`, or simply
 * forget to include the sign-in path, and every request to it is redirected
 * to itself until the browser gives up.
 *
 * That is a plausible mistake rather than an exotic one, and the failure has
 * no error message attached — so the gate now treats `signInUrl` as public
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
 * out — the access cookie lasts fifteen minutes against the refresh cookie's
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
});
