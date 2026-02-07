## Plan: Migrate Stratos to Deno Runtime

**TL;DR:** Migrate Stratos from Node.js/pnpm to Deno runtime by: (1) adding `deno.json` workspace configuration, (2) updating test files to use Deno's native test runner with `@std/testing/bdd` and `@std/expect`, (3) updating Node built-in imports to use `node:` prefix in test files, and (4) updating the Dockerfile to use official Deno image. The codebase already uses ESM (`"type": "module"`) and most source files already use `node:` prefixed imports.

**Steps**

1. **Create root [deno.json](deno.json)** for workspace configuration
   - Configure `"nodeModulesDir": "auto"` for npm package compatibility (needed for `@libsql/client`, `@atproto/*` packages)
   - Define workspace members for `stratos-core` and `stratos-service`
   - Configure TypeScript `compilerOptions` matching existing settings
   - Set up tasks: `test`, `lint`, `dev`, etc.
   - Add `imports` for standard library (`@std/testing`, `@std/expect`, `@std/assert`)

2. **Create package-level `deno.json` files**
   - [stratos-core/deno.json](stratos-core/deno.json): Configure exports, include test files
   - [stratos-service/deno.json](stratos-service/deno.json): Configure exports, tasks for running service

3. **Update Node built-in imports to use `node:` prefix** in all test files (6 files in total):
   - `'fs/promises'` → `'node:fs/promises'`
   - `'path'` → `'node:path'`
   - `'os'` → `'node:os'`
   - `'crypto'` → `'node:crypto'`

   Files: [stratos-core/tests/blob.test.ts](stratos-core/tests/blob.test.ts), [stratos-core/tests/record.test.ts](stratos-core/tests/record.test.ts), [stratos-core/tests/repo.test.ts](stratos-core/tests/repo.test.ts), [stratos-service/tests/integration.test.ts](stratos-service/tests/integration.test.ts), [stratos-service/tests/blobstore.test.ts](stratos-service/tests/blobstore.test.ts), [stratos-service/tests/api.test.ts](stratos-service/tests/api.test.ts)

4. **Migrate test files from Vitest to Deno's native test runner**
   - Replace `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'` with:
     - `import { describe, it, beforeEach, afterEach, beforeAll, afterAll } from '@std/testing/bdd'`
     - `import { expect } from '@std/expect'`
     - `import { stub, spy } from '@std/testing/mock'` (for `vi.fn()` replacements)
   - Update mock/spy patterns: `vi.fn()` → `spy()` or `stub()`
   - Ensure test file naming follows Deno conventions (already using `*.test.ts`)

   Files to update (12 total):
   - [stratos-core/tests/blob.test.ts](stratos-core/tests/blob.test.ts)
   - [stratos-core/tests/db.test.ts](stratos-core/tests/db.test.ts)
   - [stratos-core/tests/enrollment.test.ts](stratos-core/tests/enrollment.test.ts)
   - [stratos-core/tests/hydration.test.ts](stratos-core/tests/hydration.test.ts)
   - [stratos-core/tests/record.test.ts](stratos-core/tests/record.test.ts)
   - [stratos-core/tests/repo.test.ts](stratos-core/tests/repo.test.ts)
   - [stratos-core/tests/stub.test.ts](stratos-core/tests/stub.test.ts)
   - [stratos-core/tests/validation.test.ts](stratos-core/tests/validation.test.ts)
   - [stratos-service/tests/api.test.ts](stratos-service/tests/api.test.ts)
   - [stratos-service/tests/blobstore.test.ts](stratos-service/tests/blobstore.test.ts)
   - [stratos-service/tests/enrollment.test.ts](stratos-service/tests/enrollment.test.ts)
   - [stratos-service/tests/integration.test.ts](stratos-service/tests/integration.test.ts)

5. **Update [Dockerfile](Dockerfile)** for Deno
   - Replace `FROM node:24-alpine` with `FROM denoland/deno:alpine`
   - Remove pnpm/corepack setup (lines 6-7)
   - Keep non-root user creation but adjust for deno user
   - Use `deno install --entrypoint stratos-service/src/bin/stratos.ts` instead of `pnpm install`
   - Update `CMD` to `["deno", "run", "-A", "stratos-service/src/bin/stratos.ts"]`
   - Update healthcheck using `deno eval`

6. **Update [docker-compose.yml](docker-compose.yml)** and [docker-compose.test.yml](docker-compose.test.yml)\*\*
   - Update health check commands if needed (current wget-based approach should still work)

7. **Remove [vitest.config.ts](vitest.config.ts)** (no longer needed)

8. **Update root [package.json](package.json)** scripts
   - Update `test` script to use `deno test`
   - Keep package.json for npm dependency declarations (Deno reads it)

**Verification**

1. Run `deno install` to install dependencies
2. Run `deno test` to execute all tests
3. `docker build -t stratos .` to build container
4. Start container with test environment:
   ```bash
   docker run -e STRATOS_SERVICE_DID=did:plc:test -e STRATOS_PUBLIC_URL=http://localhost:3100 -e STRATOS_ALLOWED_DOMAINS=test.local -p 3100:3100 stratos
   ```
5. Verify health endpoint: `curl http://localhost:3100/health`

**Decisions**

- Use Deno's native test runner with `@std/testing/bdd` + `@std/expect` (user preference)
- Keep `package.json` files for npm dependency declarations (Deno's package.json support)
- Use `nodeModulesDir: "auto"` for npm packages with native bindings (`@libsql/client`)
- Use `-A` (allow all permissions) in Docker for simplicity; can be restricted later
