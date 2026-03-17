/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // Exclude native modules from client-side bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        '@lancedb/lancedb': false,
      };
    }
    
    // Handle .node files
    config.module.rules.push({
      test: /\.node$/,
      use: 'node-loader',
    });
    
    // Externalize native modules for server
    if (isServer) {
      config.externals = [...(config.externals || []), '@lancedb/lancedb'];
    }

    return config;
  },
};

export default nextConfig;
