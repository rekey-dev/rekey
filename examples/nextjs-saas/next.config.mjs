import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This example lives in a pnpm monorepo; pin the trace root to this app so
  // Next doesn't pick an unrelated lockfile higher up the tree.
  outputFileTracingRoot: __dirname,
  // The ReliPay SDKs ship ESM only — Next bundles them server-side fine, but
  // transpilePackages keeps the App Router / Turbopack happy with workspace
  // packages that aren't pre-compiled to the consumer's target.
  transpilePackages: [
    '@relipay/node',
    '@relipay/nextjs',
    '@relipay/react',
    '@relipay/shared-types',
  ],
};
export default nextConfig;
