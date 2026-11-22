# stratos-service tests

Unit and integration tests for the Stratos service layer. Run with vitest from the monorepo root:

```bash
pnpm exec vitest run
```

## Test files

| File                           | What it covers                                                             |
| ------------------------------ | -------------------------------------------------------------------------- |
| `api.test.ts`                  | XRPC handler routing, request/response validation                          |
| `blobstore.test.ts`            | Blob storage backends (disk, S3)                                           |
| `enrollment.test.ts`           | Enrollment adapter logic                                                   |
| `enrollment-status.test.ts`    | Enrollment status endpoint                                                 |
| `handlers.test.ts`             | Record/repo handler logic with actor stores                                |
| `integration.test.ts`          | Full-stack SQLite integration (enrollment → record CRUD → boundaries)      |
| `lexicon.test.ts`              | Lexicon schema validation                                                  |
| `mst-handlers.test.ts`         | MST commit and verification handlers                                       |
| `oauth-scope.test.ts`          | OAuth scope parsing and validation                                         |
| `postgres-integration.test.ts` | Full-stack PostgreSQL integration (same coverage as `integration.test.ts`) |
| `signer.test.ts`               | Repo signing operations                                                    |
| `storage-adapter.test.ts`      | MST storage adapter                                                        |
| `subscription-auth.test.ts`    | WebSocket subscription authentication                                      |
| `user-agent.test.ts`           | User-agent header parsing                                                  |

## PostgreSQL integration tests

`postgres-integration.test.ts` exercises the Postgres storage backend against a real database. The test starts its own throwaway `postgres:19-alpine` container through Testcontainers (`startPostgresContainer()` in `helpers/test-env.ts`), so it needs no database URL or compose file. It does need a container runtime that Testcontainers can reach, such as Docker or Podman, and it fails in `beforeAll` when none is available. The other Postgres tests (`boundary-audit-postgres.test.ts`, `boundary-catalog/postgres.test.ts`, `service-boundary-admission.test.ts`) start containers the same way.

### Running

```bash
pnpm exec vitest run tests/postgres-integration.test.ts
```

The full suite (`pnpm exec vitest run`) includes these tests and starts the containers as well.

With rootless Docker, point Testcontainers at the rootless daemon and disable its Ryuk cleanup container if it cannot start:

```bash
export DOCKER_CONTEXT=rootless
export DOCKER_HOST="$(docker context inspect rootless --format '{{.Endpoints.docker.Host}}')"
export TESTCONTAINERS_RYUK_DISABLED=true
```

### What's tested

The PG integration test mirrors the SQLite integration test coverage:

- **Actor lifecycle** — create, exists, destroy, per-actor schema isolation
- **Record operations** — index, read, list by collection, delete, backlinks
- **Repo operations** — block put/get, root management, block counting
- **Sequence operations** — append events, latest sequence, cursor-based retrieval
- **Enrollment store** — enroll, unenroll, boundary CRUD, list enrollments

Each actor gets an isolated Postgres schema (`actor_{hash}`). Schemas are cleaned up in `afterEach`.

### Test helpers

Shared test utilities live in `helpers/test-env.ts`:

| Export                         | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `cborToRecord()`               | Test stub for CBOR→record deserialization  |
| `createCid()`                  | Generate a CID from a string or bytes      |
| `createMockBlobStoreCreator()` | Factory returning per-DID mock blob stores |
| `startPostgresContainer()`     | Start a Postgres container, return its URL |
| `stopPostgresContainer()`      | Stop the container started above           |
