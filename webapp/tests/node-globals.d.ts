// Tests run under Node (vitest), but this tsconfig deliberately excludes
// @types/node: src/ is a browser app where Node globals like `process` must
// stay type errors (vite.config.ts disables the `process` polyfill). Declare
// only the two Node globals the tests rely on. buffer-check.test.ts asserts on
// the *global* Buffer on purpose, so importing from node:buffer is not an
// option there.
// eslint-disable-next-line no-var -- `var` is required so Buffer appears on `typeof globalThis`
declare var Buffer: typeof import('buffer').Buffer
declare const global: typeof globalThis
