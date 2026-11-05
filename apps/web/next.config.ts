import type { NextConfig } from 'next';

const config: NextConfig = {
  // The domain packages ship TypeScript source so Node can run them directly
  // in tests without a build step; Next compiles them as part of the app.
  transpilePackages: ['@studyos/core', '@studyos/db'],
  typedRoutes: false,
};

export default config;
