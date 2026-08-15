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
  // Self-contained server output for slim runtime images (same rationale as
  // apps/panel — see its next.config.mjs).
  output: 'standalone',
  // Monorepo: trace dependencies from the workspace root so hoisted/workspace
  // packages resolve inside the standalone bundle.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@rekey.dev/shared-types', '@rekey.dev/node', '@rekey.dev/nextjs'],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default nextConfig;
