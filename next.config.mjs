/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  images: { unoptimized: true },
  experimental: { serverActions: { bodySizeLimit: '20mb' } },
  serverExternalPackages: ['sharp', 'pg', 'bcryptjs', 'xlsx'],
};
export default nextConfig;
