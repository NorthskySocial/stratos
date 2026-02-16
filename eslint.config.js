import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'
import prettierConfig from 'eslint-config-prettier'

export default defineConfig([
  {
    ignores: [
      'dist/',
      'release/',
      'node_modules/',
      '**/dist/',
      '**/node_modules/',
      'stratos-core/',
      'stratos-service/',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { js },
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        Deno: 'readonly',
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ['test/scripts/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './test/scripts/tsconfig.json',
      },
    },
  },
  prettierConfig,
])
