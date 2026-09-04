import { defineConfig } from 'vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const sentryBuildConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
  process.env.SENTRY_ORG &&
  process.env.SENTRY_PROJECT,
)

const sentryPlugins = sentryBuildConfigured
  ? sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      release: { name: process.env.VITE_SENTRY_RELEASE ?? 'unknown' },
      sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
    })
  : []

export default defineConfig({
  plugins: [svelte(), tailwindcss(), ...sentryPlugins],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Source maps exist only for a configured Sentry release. Sentry uploads
    // them, then removes them using filesToDeleteAfterUpload above.
    sourcemap: sentryBuildConfigured ? 'hidden' : false,
  },
  server: {
    port: 5175,
    strictPort: true,
  },
})
