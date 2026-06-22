import { defineConfig } from 'vitest/config'

const nodeProject = (name: string) => ({
  extends: true,
  test: {
    name,
    root: `./${name}`,
    environment: 'node' as const,
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'stratos-core/src/**/*.ts',
        'stratos-service/src/**/*.ts',
        'stratos-client/src/**/*.ts',
        'stratos-indexer/src/**/*.ts',
        'stratos-feedgen/src/**/*.ts',
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
    projects: [
      nodeProject('stratos-core'),
      nodeProject('stratos-service'),
      nodeProject('stratos-client'),
      nodeProject('stratos-indexer'),
      nodeProject('stratos-feedgen'),
      './webapp/vite.config.ts',
    ],
  },
})
