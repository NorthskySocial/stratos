import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, '../..', ''), ...process.env }
  const webappUrl = env.VITE_WEBAPP_URL ? new URL(env.VITE_WEBAPP_URL) : null

  return {
    // base: '/',
    envDir: '../..',
    plugins: [svelte()],
    optimizeDeps: {
      include: ['@atproto/oauth-client-browser', '@atproto/api'],
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      cors: true,
      fs: {
        strict: false,
      },
      hmr: webappUrl
        ? {
            host: webappUrl.hostname,
            protocol: webappUrl.protocol === 'https:' ? 'wss' : 'ws',
            clientPort: 443,
            timeout: 30000,
          }
        : undefined,
    },
  }
})
