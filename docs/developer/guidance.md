# Code Coverage Improvement Guidance for Stratos Service

This document provides a strategic overview of how to improve code coverage for `stratos-service`.

## 📊 Current Status Overview

Based on recent coverage reports, `stratos-service` has several areas with low coverage:

| Module                   | Coverage (%) | Target Areas                                     |
| ------------------------ | ------------ | ------------------------------------------------ |
| `api/records`            | ~35%         | `create.ts`, `delete.ts`, `read.ts`, `update.ts` |
| `features/hydration`     | ~64%         | `handler.ts` (0%)                                |
| `infra/auth`             | ~33%         | `introspection-client.ts`, `verifiers.ts`        |
| `infra/storage/postgres` | ~22%         | Most stores (record, blob, repo, sequence)       |
| `subscription`           | ~12%         | `subscribe-records.ts`                           |
| `oauth`                  | ~42%         | `client.ts`, `authorize.ts`, `revoke.ts`         |

## 🚀 Key Recommendations

### 1. Prioritize Missing CRUD Handlers

The core record management logic in `stratos-service/src/api/records/` is under-tested.

- **Action**: Create integration tests for `delete.ts`, `read.ts`, and `update.ts`.
- **Tip**: Use `stratos-service/tests/integration.test.ts` as a template. Ensure you cover both success cases and error conditions (e.g., record not found, invalid boundary).

### 2. Hydration Handler Integration Tests

While the `hydration` adapter has good coverage (~93%), the `handler.ts` has 0%.

- **Action**: Implement integration tests that hit the `zone.stratos.repo.hydrateRecord` and `hydrateRecords` XRPC endpoints.
- **Focus**: Verify that the boundary-based filtering logic works correctly when accessed via HTTP.

### 3. PostgreSQL Storage Adapters

The SQLite adapters are relatively well-tested, but the Postgres counterparts are lagging.

- **Action**: Expand the integration test suite to run against a Postgres container.
- **Tip**: Ensure parity between `sqlite` and `postgres` adapter tests to guarantee consistent behavior across database backends.

### 4. Subscription & Firehose Testing

The `subscribe-records.ts` file has very low coverage due to the complexity of testing WebSockets.

- **Action**: Use a WebSocket client in tests to connect to the sync stream and verify that events are emitted correctly after repository commits.
- **Tooling**: `vi.waitFor` or similar patterns can help manage the asynchronous nature of firehose events.

### 5. OAuth & Auth Edge Cases

Auth verifiers and OAuth handlers have significant uncovered branches, especially for error handling and token revocation.

- **Action**: Add unit tests for `stratos-service/src/infra/auth/verifiers.ts` covering expired tokens, invalid DPoP proofs, and missing scopes.
- **Action**: Test the `revoke` and `status` OAuth endpoints.

## 🛠 Testing Best Practices

- **Use the Data Factory**: Leverage `stratos-service/tests/utils/data-factory.ts` to generate consistent mock data.
- **Anime-themed Mocks**: As per project guidelines, use names and places from popular 90s anime for mock data (e.g., "Neo Tokyo", "Shinji Ikari").
- **Error Boundaries**: Don't just test the "happy path". Explicitly test for `StratosError` types to ensure the API returns correct XRPC error codes.
- **Coverage Command**: Run `pnpm exec vitest run --coverage stratos-service` to see updated metrics.

## 📈 Next Steps

1. Focus on `stratos-service/src/api/records/read.ts` and `delete.ts` first, as these are critical path components.
2. Address the 0% coverage in `hydration/handler.ts`.
3. Improve `infra/auth/verifiers.ts` to ensure security logic is fully validated.
