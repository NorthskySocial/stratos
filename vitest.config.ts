import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'stratos-core/src/**/*.ts',
        'stratos-service/src/**/*.ts',
        'stratos-client/src/**/*.ts',
        'stratos-indexer/src/**/*.ts',
        'webapp/src/**/*.{ts,svelte,js}',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/*.d.ts',
        'webapp/src/main.ts',
      ],
    },
  },
})
