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

`postgres-integration.test.ts` exercises the Postgres storage backend against a real database. Tests are **skipped by default** — they only run when `STRATOS_POSTGRES_URL` is set.

### Running

Start a local Postgres instance:

```bash
docker compose -f docker-compose.postgres.yml up -d
```

Then run the tests:

```bash
STRATOS_POSTGRES_URL=postgres://stratos:stratos@localhost:5432/stratos \
  pnpm exec vitest run tests/postgres-integration.test.ts
```

Or run the full suite with PG tests included:

```bash
STRATOS_POSTGRES_URL=postgres://stratos:stratos@localhost:5432/stratos \
  pnpm exec vitest run
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

| Export                         | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `POSTGRES_URL`                 | Value of `STRATOS_POSTGRES_URL` env var                                      |
| `HAS_POSTGRES`                 | `true` when `STRATOS_POSTGRES_URL` is set                                    |
| `IS_POSTGRES`                  | `true` when `STRATOS_TEST_BACKEND=postgres` or `STRATOS_POSTGRES_URL` is set |
| `cborToRecord()`               | Test stub for CBOR→record deserialization                                    |
| `createCid()`                  | Generate a CID from a string or bytes                                        |
| `createMockBlobStore()`        | In-memory blob store mock                                                    |
| `createMockBlobStoreCreator()` | Factory returning per-DID mock blob stores                                   |
| `createTestBackend()`          | Returns a SQLite or Postgres `ActorStore` based on env                       |
