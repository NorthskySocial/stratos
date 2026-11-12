# Implementation Checklist: ATProtocol Blob Support for Stratos

::: warning Historical checklist
This checklist tracked the original [blob support design](./blob-support.md).
Blob reads shipped, but several ticked items were never built or were built
differently. Each such item carries a correction. The
[implementation summary](./blob-support.md#what-the-implementation-does) is
the current description.
:::

## 1. Stratos-Core: Port & Domain Logic

- [x] **BlobAuthService Port**
  - [x] Define `BlobAuthService` interface in `stratos-core/src/blob/auth-service.ts`.
  - [x] Add `canAccessBlob(viewerDid, actorDid, blobCid)` method.
  - [x] Add `canAccessBlobs(viewerDid, actorDid, blobCids)` batch method.
- [x] **BlobMetadataReader Updates**
  - [x] Ensure `BlobMetadataReader` can efficiently fetch all records associated with a CID.
- [x] **Domain Errors**
  - [x] Add `BlobAccessDeniedError` to `stratos-core/src/shared/errors.ts`.

## 2. Stratos-Service: Adapter & Infrastructure

- [x] **BlobAuthService Implementation**
  - [x] Implement `BlobAuthServiceImpl` in `stratos-service/src/features/blob/adapter.ts`.
  - [x] Integrate `BoundaryResolver` for viewer identity resolution.
  - [x] Implement logic to join `stratos_record_blob` with `stratos_record` for boundary checking.
- [x] **Caching Layer**
  - [ ] Implement `ViewerBoundaryCache` (TTL-based). Not built: no such cache exists.
  - [ ] Implement `BlobAuthCache` for positive/negative result persistence. Not built: every check reads storage.
- [x] **Database Optimizations**
  - [x] (Optional) Implement `stratos_record_boundary` denormalized table if performance requires it.
  - [x] Add the necessary indexes to `stratos_record_blob`.

## 3. Stratos-Service: XRPC Handlers

- [x] **com.atproto.sync.getBlob**
  - [x] Create handler in `stratos-service/src/api/handlers/blob-handlers.ts`, registered in `stratos-service/src/features/sync/handler.ts`.
  - [x] Implement authentication check (DPoP/OAuth). Authentication is optional; anonymous callers are denied.
  - [x] Integrate `BlobAuthService` for permission check.
  - [x] Stream blob content from `BlobContentStore` (Disk/S3) on success.
  - [x] Reject a boundary mismatch. As built: HTTP 400 `BlobBlocked`.
  - [x] Reject a missing blob or member. As built: HTTP 400 `BlobNotFound` or `RepoNotFound`.

## 4. Stratos-Client & Documentation

- [x] **Client Library**
  - [ ] Add `getBlob` method to `StratosClient`. Not built: the client only declares the OAuth scope.
  - [ ] Handle binary stream response. Not built.
- [x] **Documentation Updates**
  - [x] Update `stratos-client/README.md` to mark `com.atproto.sync.getBlob` as supported.
  - [x] Update `docs/client/api-reference.md`.

## 5. Testing & Verification

- [x] **Unit Tests (`stratos-core`)**
  - [x] Test `BlobAuthService` logic with various boundary combinations.
  - [x] Test batch authorization performance.
- [x] **Integration Tests (`stratos-service`)**
  - [x] Verify `getBlob` XRPC endpoint with authenticated/unauthenticated requests.
  - [x] Verify boundary enforcement (access granted vs. blocked).
  - [x] Test S3 and Disk blob store backends.
- [ ] **Performance Benchmarking**
  - [ ] Measure latency of authorized blob downloads under load.

## 6. Open Questions / Policies

- [x] **Orphaned Blobs Policy**: decided in code. Only the owner reads an unattached blob.
- [x] **Public Blobs Policy**: decided in code. Anonymous callers are always denied.
