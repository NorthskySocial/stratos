import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    name: 'stratos-browser',
    root,
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})
