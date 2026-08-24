// dedicated config for Stryker: a default-named vitest.config.ts here would
// shadow the workspace root config and break `vitest run --project stratos-client`.
// Vitest and the Stryker vitest-runner require the default export, so the
// named-export convention does not apply here.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})
