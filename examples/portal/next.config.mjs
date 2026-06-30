import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server output for slim runtime images (same rationale as
  // apps/panel — see its next.config.mjs).
  output: 'standalone',
  // Monorepo: trace dependencies from the workspace root so hoisted/workspace
  // packages resolve inside the standalone bundle.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@relipay/shared-types', '@relipay/node', '@relipay/nextjs'],
  reactStrictMode: true,
};
export default nextConfig;
