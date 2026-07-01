/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @relipay/node ships ESM only — Next bundles it server-side fine.
  transpilePackages: ['@relipay/node', '@relipay/shared-types'],
};
export default nextConfig;
