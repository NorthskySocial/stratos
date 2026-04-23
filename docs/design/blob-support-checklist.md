# Implementation Checklist: ATProtocol Blob Support for Stratos

This checklist tracks the implementation of ATProtocol blob support as outlined in `docs/design/blob-support.md`.

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
  - [x] Implement `BlobAuthServiceImpl` in `stratos-service/src/features/blob/auth-service-adapter.ts`.
  - [x] Integrate `BoundaryResolver` for viewer identity resolution.
  - [x] Implement logic to join `stratos_record_blob` with `stratos_record` for boundary checking.
- [x] **Caching Layer**
  - [x] Implement `ViewerBoundaryCache` (TTL-based).
  - [x] Implement `BlobAuthCache` for positive/negative result persistence.
- [x] **Database Optimizations**
  - [x] (Optional) Implement `stratos_record_boundary` denormalized table if performance requires it.
  - [x] Add the necessary indexes to `stratos_record_blob`.

## 3. Stratos-Service: XRPC Handlers

- [x] **com.atproto.sync.getBlob**
  - [x] Create handler in `stratos-service/src/api/handlers/sync.ts` (or new file).
  - [x] Implement authentication check (DPoP/OAuth).
  - [x] Integrate `BlobAuthService` for permission check.
  - [x] Stream blob content from `BlobContentStore` (Disk/S3) on success.
  - [x] Return `403 Forbidden` on boundary mismatch.
  - [x] Return `404 Not Found` if blob or actor does not exist.

## 4. Stratos-Client & Documentation

- [x] **Client Library**
  - [x] Add `getBlob` method to `StratosClient`.
  - [x] Handle binary stream response.
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

- [ ] **Orphaned Blobs Policy**: Decide on access rules for unattached blobs.
- [ ] **Public Blobs Policy**: Define behavior for records with no boundaries.
