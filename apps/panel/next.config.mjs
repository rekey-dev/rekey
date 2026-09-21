import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Conservative on purpose. `frame-ancestors 'none'` plus `X-Frame-Options`
// closes the clickjacking hole (this console was framable); `Referrer-Policy:
// no-referrer` stops a token-bearing URL leaking to a third party through the
// Referer header, which matters because reset / invite / MFA links arrive with
// their token in the query string.
//
// Deliberately NOT a full resource CSP. A console that loads nothing external
// can have one; this one loads Google Analytics when an operator sets a
// measurement id, and a `script-src 'self'` here would silently break it. A
// resource policy for this app needs its external origins enumerated and then
// verified in a browser, which is its own change.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (server.js + only the traced node_modules)
  // so the runtime image needs no `pnpm install` and ships none of the full
  // dependency tree, shrinks the image from ~1GB to a few hundred MB.
  output: 'standalone',
  // In a monorepo, trace deps from the workspace root so the standalone
  // bundle resolves hoisted/workspace packages correctly.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Workspace package transpilation isn't needed today (we only import types
  // from @rekey.dev/shared-types), but keep this here so future use of
  // workspace runtime helpers Just Works.
  transpilePackages: ['@rekey.dev/shared-types'],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  experimental: {
    // Required for `forbidden()` in lib/api.ts. Without it a 403 from the API
    // falls through to the generic error boundary, which tells the operator
    // the panel is broken and offers a "Try again" that can never succeed,
    // the UI could not distinguish "not yours" from "we're down".
    // `notFound()` is stable and needs no flag; `forbidden()` does.
    authInterrupts: true,
    // The panel does not prefetch (every link goes through
    // `src/components/Link.tsx`, which defaults `prefetch` to false), so these
    // no longer describe prefetch lifetimes in practice. README.md
    // "Navigation performance" has the measurements behind that change.
    //
    // What `dynamic` still decides: a page the operator VISITED in the last 30
    // seconds is reused from the router cache, so going back to a tab costs no
    // request. That is also the window in which a page can be stale on screen.
    // Somebody ELSE's change can show up to 30s late; the operator's own saves
    // are covered by `<RefreshAfterAction>`, which runs one `router.refresh()`
    // after an action redirect lands (see `(authed)/layout.tsx`).
    //
    // Setting it to 0 would trade the other way: no stale window, so no need
    // for the post-save refresh, but every revisit of a tab becomes a full
    // render. Tab revisits are far more frequent than saves, so 30 is fewer API
    // calls overall. decisions.md (2026-09-19) records that choice.
    //
    // An earlier version of this comment measured three to four renders per tab
    // click at `dynamic: 0` (viewport prefetch, hover prefetch, then the real
    // navigation). With prefetching off, a click measured exactly one render on
    // a production build at these values.
    //
    // `static` applies only to prefetched loading boundaries, which nothing
    // requests any more. Left at 180 so a link that opts back into prefetching
    // behaves as it did before.
    //
    // Whatever these are, the API's RATE_LIMIT_MAX has to be sized for the
    // traffic the panel produces, and every operator shares it.
    staleTimes: { dynamic: 30, static: 180 },
  },
};
export default nextConfig;
