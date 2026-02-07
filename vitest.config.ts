import {defineConfig} from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@northsky/stratos-core': path.resolve(__dirname, './stratos-core/dist/index.js'),
      '@northsky/stratos-service': path.resolve(__dirname, './stratos-service/dist/index.js'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
  },
})