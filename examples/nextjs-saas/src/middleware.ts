/**
 * Route protection via @relipay/nextjs/middleware.
 *
 * Public routes pass through; everything else requires the access cookie's
 * presence (cheap, no network). Missing → redirect to /login?next=… . Token
 * *validity* is checked deeper, when a server component calls auth().
 */

import { relipayMiddleware } from '@relipay/nextjs/middleware';

export default relipayMiddleware({
  signInUrl: '/login',
  publicRoutes: [
    '/',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/api/auth',
    // Component gallery — adapts to signed-in/out via <SignedIn>/<SignedOut>.
    '/kitchen-sink',
  ],
});

export const config = {
  // Run on everything except Next internals + static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
