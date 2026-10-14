import path from 'node:path';
import type { NextConfig } from 'next';

// The repo's .env (DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY, ...) also configures the web app in
// development; in Docker the variables come from the environment.
const root = path.resolve(process.cwd(), '../..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env: use the environment as is
}
// Job artifacts (plans, reports) live next to the worker's.
process.env.WM_DATA_DIR ??= path.join(root, 'data');

const config: NextConfig = {
  // Workspace packages are TypeScript source.
  transpilePackages: ['@wm/core', '@wm/db', '@wm/net', '@wm/planner', '@wm/wp-client'],
  // Node-only libraries, loaded from node_modules at runtime rather than bundled.
  serverExternalPackages: ['pg', 'pg-boss', 'undici'],
  // The packages import their TypeScript files with .js specifiers (NodeNext style); Turbopack can't
  // map those, so the web app builds with webpack.
  webpack: (webpackConfig: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    webpackConfig.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return webpackConfig;
  },
  outputFileTracingRoot: root,
  output: 'standalone',
  poweredByHeader: false,
};

export default config;
