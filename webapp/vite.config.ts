import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

import * as path from 'path'

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, '../..', ''), ...process.env }
  const webappUrl = env.VITE_WEBAPP_URL ? new URL(env.VITE_WEBAPP_URL) : null

  return {
    // base: '/',
    envDir: '../..',
    plugins: [
      svelte({
        compilerOptions: {
          hmr: command === 'serve' && !env.VITEST,
        },
      }),
      nodePolyfills({
        include: [
          'buffer',
          'crypto',
          'stream',
          'events',
          'http',
          'https',
          'url',
          'querystring',
          'punycode',
          'vm',
          'async_hooks',
        ],
        globals: {
          Buffer: true,
          global: true,
          process: false,
        },
      }),
    ],
    resolve: {
      alias: {
        jose: path.resolve(
          __dirname,
          '../node_modules/.pnpm/jose@5.10.0/node_modules/jose/dist/browser/index.js',
        ),
        perf_hooks: path.resolve(__dirname, './src/perf_hooks.ts'),
        'vite-plugin-node-polyfills/shims/buffer': path.resolve(
          __dirname,
          'node_modules/vite-plugin-node-polyfills/shims/buffer/dist/index.js',
        ),
        'vite-plugin-node-polyfills/shims/global': path.resolve(
          __dirname,
          'node_modules/vite-plugin-node-polyfills/shims/global/dist/index.js',
        ),
      },
      conditions: mode === 'test' ? ['browser'] : ['browser', 'import'],
    },
    define: {
      'process.version': JSON.stringify('v18.0.0'),
    },
    optimizeDeps: {
      include: ['@atproto/oauth-client-browser', '@atproto/api', 'buffer'],
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        external: ['postgres'],
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('@atproto/api')) {
                return 'vendor-atproto'
              }
              if (id.includes('svelte')) {
                return 'vendor-svelte'
              }
              // Group all heavy polyfills together
              if (
                id.includes('buffer') ||
                id.includes('base64-js') ||
                id.includes('ieee754') ||
                id.includes('crypto-browserify') ||
                id.includes('elliptic') ||
                id.includes('bn.js') ||
                id.includes('browserify-sign') ||
                id.includes('browserify-aes') ||
                id.includes('browserify-des') ||
                id.includes('browserify-cipher') ||
                id.includes('parse-asn1') ||
                id.includes('asn1.js') ||
                id.includes('hash.js') ||
                id.includes('create-hmac') ||
                id.includes('create-hash') ||
                id.includes('create-ecdh') ||
                id.includes('pbkdf2') ||
                id.includes('randombytes') ||
                id.includes('randomfill') ||
                id.includes('diffie-hellman') ||
                id.includes('public-encrypt') ||
                id.includes('miller-rabin') ||
                id.includes('brorand') ||
                id.includes('minimalistic-crypto-utils') ||
                id.includes('hmac-drbg')
              ) {
                return 'vendor-polyfills'
              }
              if (
                id.includes('@atproto/oauth-client-browser') ||
                id.includes('@atproto/crypto')
              ) {
                return 'vendor-atproto-oauth'
              }
              return 'vendor'
            }
          },
        },
        onwarn(warning, warn) {
          if (
            warning.code === 'CIRCULAR_DEPENDENCY' &&
            warning.message.includes('manual chunk')
          ) {
            return
          }
          if (
            warning.code === 'MODULE_LEVEL_DIRECTIVE' ||
            (warning.code === 'PLUGIN_WARNING' &&
              warning.plugin === 'vite:resolve' &&
              warning.message.includes('node:async_hooks')) ||
            (warning.code === 'EVAL' && warning.id?.includes('vm-browserify'))
          ) {
            return
          }
          warn(warning)
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      exclude: [
        'node_modules',
        'dist',
        '.idea',
        '.git',
        '.cache',
        'tests/e2e/**',
      ],
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
