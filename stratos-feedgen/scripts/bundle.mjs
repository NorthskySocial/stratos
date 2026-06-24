// Produces a single-file Node bundle for production deployment.
// Externals: native modules and their deps that can't be bundled.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/bin/main.ts'],
  outfile: 'dist-bundle/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  minify: false,
  logLevel: 'info',
  // @libsql/client ships native .node bindings; postgres and drizzle use
  // dynamic imports that confuse the bundler when paired with libsql.
  // Keep them external and install via npm in the production image.
  external: ['@libsql/client', '@libsql/*', 'libsql', 'postgres'],
  // Bundled CJS deps occasionally call require(); provide a shim.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_fn } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_fn(__filename);',
    ].join('\n'),
  },
})
