import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// anchor project paths to this file so vitest resolves them from any cwd
const rootDir = dirname(fileURLToPath(import.meta.url))

const nodeProject = (name: string) => ({
  extends: true,
  test: {
    name,
    root: join(rootDir, name),
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
      join(rootDir, 'webapp/vite.config.ts'),
    ],
  },
})
