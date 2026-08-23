// dedicated config for Stryker: a default-named vitest.config.ts here would
// shadow the workspace root config and break `vitest run --project stratos-client`
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})
