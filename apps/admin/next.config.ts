import path from 'node:path';
import type { NextConfig } from 'next';

// Read at BUILD time, not at runtime, and that is not a choice this file makes:
// Next serialises `rewrites()` into .next/routes-manifest.json during
// `next build`, so the destination below is frozen into the image. The value
// is therefore a build argument in docker/Dockerfile.admin, defaulting to the
// compose service name `http://api:4000` — which is stable across deployments
// precisely because it is a compose network name and not a hostname anyone
// configures per host. Changing it requires rebuilding the admin image; every
// other admin setting is read at runtime.
//
// The localhost fallback is what `pnpm dev` uses and is unchanged.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // Emits .next/standalone: a minimal server.js plus only the node_modules
  // files output tracing proved are reachable, so the runtime image does not
  // have to carry the whole pnpm workspace install. See
  // docker/Dockerfile.admin.
  output: 'standalone',

  // The trace root has to be the monorepo root, not apps/admin, or the trace
  // stops at the workspace symlinks and @ventia/ui never makes it into the
  // bundle.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),

  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_INTERNAL_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
