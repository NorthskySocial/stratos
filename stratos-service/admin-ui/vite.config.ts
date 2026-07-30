import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, '../..', ''), ...process.env }
  const serviceUrl = env.VITE_STRATOS_SERVICE_URL || 'http://localhost:3100'

  return {
    root,
    // Served at /admin by the service in production; dev serves at /.
    base: command === 'build' ? '/admin/' : '/',
    envDir: '../..',
    plugins: [svelte(), tailwindcss()],
    build: {
      outDir: '../dist/admin-ui',
      emptyOutDir: true,
    },
    server: {
      port: 5174,
      strictPort: true,
      // The auth + API surface lives on the running service. The service must
      // run with STRATOS_DEV_MODE=true or the CSRF origin screen rejects
      // proxied admin calls with 403.
      proxy: {
        '/xrpc': serviceUrl,
        '/health': serviceUrl,
        '/admin': serviceUrl,
      },
    },
  }
})
