/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @rekey.dev/node ships ESM only — Next bundles it server-side fine.
  transpilePackages: ['@rekey.dev/node', '@rekey.dev/shared-types'],
};
export default nextConfig;
