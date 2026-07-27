/**
 * Route protection via @rekey.dev/nextjs/middleware — mirrors
 * examples/nextjs-saas. Public routes pass through; everything else requires
 * the access cookie's *presence* (cheap, no network call). Token validity is
 * verified when a server component calls auth().
 */

import { rekeyMiddleware } from '@rekey.dev/nextjs/middleware';

export default rekeyMiddleware({
  signInUrl: '/login',
  publicRoutes: ['/login', '/api/auth'],
});

export const config = {
  // Run on everything except Next internals + static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
