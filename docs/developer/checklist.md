# Checklist: Implementing Code Coverage Improvements for Stratos Service

This checklist provides a step-by-step guide for implementing the recommendations outlined in `guidance.md`.

## 📍 1. Record CRUD Handlers

Expand coverage for `stratos-service/src/api/records/`.

- [ ] **Read Handler (`read.ts`)**
  - [ ] Create test cases for successful record retrieval.
  - [ ] Create test cases for non-existent records (expect 404).
  - [ ] Verify that invalid DID or collection parameters return appropriate errors.
- [ ] **Delete Handler (`delete.ts`)**
  - [ ] Create test cases for successful record deletion.
  - [ ] Verify that deleting a non-existent record is handled gracefully (or returns error if required).
  - [ ] Ensure the record is actually removed from the database after deletion.
  - [ ] Verify that PDS stubs are enqueued for deletion.
- [ ] **Update Handler (`update.ts`)**
  - [ ] Create test cases for successful record updates.
  - [ ] Verify that updates to non-existent records return errors.
  - [ ] Validate that boundary changes during update are correctly processed.

## 📍 2. Hydration Handlers

Target 0% coverage in `stratos-service/src/features/hydration/handler.ts`.

- [ ] **Single Record Hydration (`hydrateRecord`)**
  - [ ] Test successful hydration with valid viewer boundaries.
  - [ ] Test hydration where the viewer lacks the required boundaries (expect filtered/empty result).
  - [ ] Test with invalid record URI.
- [ ] **Batch Record Hydration (`hydrateRecords`)**
  - [ ] Test batch hydration with a mix of accessible and inaccessible records.
  - [ ] Verify that the limit of 100 records per request is enforced.
  - [ ] Test with empty record list.

## 📍 3. PostgreSQL Adapters

Improve coverage for `stratos-service/src/infra/storage/postgres/`.

- [ ] **Environment Setup**
  - [ ] Ensure a local Postgres instance or Docker container is available for testing.
  - [ ] Configure `vitest` to run storage tests against both SQLite and Postgres.
- [ ] **Adapter Parity**
  - [ ] Run existing `record-store.test.ts` logic against the Postgres adapter.
  - [ ] Run existing `blob-store.test.ts` logic against the Postgres adapter.
  - [ ] Run existing `repo-store.test.ts` logic against the Postgres adapter.

## 📍 4. Subscription & Firehose

Improve coverage for `stratos-service/src/subscription/subscribe-records.ts`.

- [ ] **Connection & Authentication**
  - [ ] Test WebSocket connection with valid/invalid service JWTs.
  - [ ] Verify that unauthorized connections are rejected.
- [ ] **Event Emission**
  - [ ] Trigger a record creation and verify that a corresponding event is emitted on the firehose.
  - [ ] Trigger a record deletion and verify the event emission.
  - [ ] Verify the structure of the emitted CBOR objects matches the lexicon.

## 📍 5. Auth & OAuth Edge Cases

Improve coverage for `stratos-service/src/infra/auth/` and `stratos-service/src/oauth/`.

- [ ] **DPoP & Token Verification**
  - [ ] Test `verifiers.ts` with expired tokens.
  - [ ] Test with invalid DPoP `htu` (HTTP URL) or `htm` (HTTP method).
  - [ ] Test with mismatched public keys.
- [ ] **OAuth Endpoints**
  - [ ] Test the `revoke` endpoint with valid and invalid tokens.
  - [ ] Test the `status` endpoint to verify current session information.

## ✅ Verification & Submission

- [ ] **Linting**: Run `pnpm run lint` to ensure no style regressions.
- [ ] **Tests**: Run `pnpm exec vitest run stratos-service` and ensure all tests pass.
- [ ] **Coverage**: Run `pnpm exec vitest run --coverage stratos-service` and verify that coverage has increased in the targeted modules.
