import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits .next/standalone: a minimal server.js plus only the node_modules
  // files that output tracing proved are reachable. Without it a runtime image
  // has to carry the whole pnpm workspace install (~1 GB here) to run
  // `next start`. Docker/Dockerfile.storefront copies the standalone bundle
  // and nothing else.
  //
  // Tracing follows the workspace symlinks, so @ventia/ui and @ventia/core are
  // pulled into standalone/packages/* automatically — but only what is
  // actually imported, which is why those packages must still be BUILT before
  // `next build` runs. A missing dist/ is not a build error here, it is a
  // silently thinner bundle.
  output: 'standalone',

  // The trace root has to be the monorepo root, not apps/storefront, or the
  // trace stops at the workspace symlinks and @ventia/ui never makes it into
  // the bundle. Next infers this from the nearest lockfile and gets it right
  // both here and in the image; stating it removes the inference (and the
  // "inferred your workspace root" warning it prints when more than one
  // lockfile is in view).
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
};

export default nextConfig;
