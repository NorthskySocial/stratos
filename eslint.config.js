import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'release/',
      'node_modules/',
      '**/dist/',
      '**/node_modules/',
      'stratos-core/',
      'stratos-service/',
      'stratos-client/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        Deno: 'readonly',
      },
    },
  },
  {
    files: ['test/scripts/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './test/scripts/tsconfig.json',
      },
    },
  },
  prettierConfig,
)
