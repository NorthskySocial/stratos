# Design Document: ATProtocol Blob Support for Stratos

## Overview

This document outlines the design for enabling ATProtocol blob support in Stratos, specifically focusing on the `com.atproto.sync.getBlob` endpoint with boundary-based access control.

## Goals

- Implement `com.atproto.sync.getBlob` XRPC endpoint.
- Enforce boundary-based access control for blobs.
- Maintain high performance for the authorization layer.
- Support existing blob storage backends (Disk and S3).

## Architecture

### Access Control Model

In ATProtocol, blobs are typically referenced by records. In Stratos, records are gated by boundaries. To maintain consistency and security, blobs must inherit the access restrictions of the records that reference them.

1.  **Direct Association**: A blob is accessible if the viewer has access to at least one record that references that blob CID.
2.  **Boundary Check**: Access to a record is determined by comparing the record's boundaries with the viewer's boundaries (via `BoundaryResolver`).
3.  **Performant Authorization**: Since blob downloads can be frequent, the authorization check must be highly optimized.

### New Components

#### 1. XRPC Handler: `com.atproto.sync.getBlob`

- **Endpoint**: `/xrpc/com.atproto.sync.getBlob`
- **Parameters**:
  - `did`: DID of the account.
  - `cid`: CID of the blob.
- **Logic**:
  1. Authenticate the viewer (DPoP/OAuth).
  2. Resolve viewer boundaries.
  3. Identify records in the actor's repo that reference the given CID.
  4. For those records, extract their boundaries.
  5. Check if the viewer shares at least one boundary with any of these records.
  6. If authorized, stream the blob from the `BlobContentStore`.
  7. If not authorized or not found, return appropriate error (404 or 403).

#### 2. Blob Authorization Service

The `BlobAuthService` is the core component for enforcing boundary-based access control for blobs. It evaluates whether a viewer has permission to access a specific blob based on the records that reference it.

##### Port Definition (`stratos-core`)

```typescript
export interface BlobAuthService {
  /**
   * Check if a viewer can access a specific blob in an actor's repository.
   *
   * @param viewerDid - DID of the requesting user (null if unauthenticated)
   * @param actorDid - DID of the account owning the blob
   * @param blobCid - CID of the blob to access
   * @returns boolean indicating if access is granted
   */
  canAccessBlob(
    viewerDid: string | null,
    actorDid: string,
    blobCid: Cid,
  ): Promise<boolean>

  /**
   * Batch check for multiple blobs in the same actor's repository.
   * Useful for UI galleries or batch exports.
   */
  canAccessBlobs(
    viewerDid: string | null,
    actorDid: string,
    blobCids: Cid[],
  ): Promise<Map<string, boolean>>
}
```

##### Implementation Logic (`stratos-service`)

The implementation follows these steps to ensure secure and performant authorization:

1.  **Identity Resolution**: Resolve the viewer's boundaries using the `BoundaryResolver`. If the viewer is the `actorDid` (the owner), access is granted immediately (bypass).
2.  **Association Lookup**: Query the `stratos_record_blob` table in the actor's store to find all `recordUri`s associated with the `blobCid`.
3.  **Boundary Extraction**:
    - Fetch the records identified in step 2.
    - Extract boundaries from each record.
    - _Optimization_: If a `stratos_record_boundary` table exists, this becomes a single join query.
4.  **Policy Evaluation**:
    - If any associated record has **no boundaries**, the blob is considered "public" within the Stratos instance (subject to service configuration).
    - If the viewer shares at least one boundary with **any** of the associated records, access is granted.
    - If no records are found associating with the blob, it is treated as an "orphaned" or "unattached" blob (see Questions).

##### Caching Strategy

To achieve a performant authorization layer, `BlobAuthService` employs multi-level caching:

- **Viewer Boundary Cache**: Results from `BoundaryResolver.getBoundaries(viewerDid)` are cached for 5-10 minutes.
- **Negative Auth Cache**: If access is denied, the result is cached for a short duration (e.g., 30s) to mitigate rapid-fire 403s.
- **Positive Auth Cache**: If access is granted, the `(viewerDid, actorDid, blobCid)` tuple is cached. This cache is invalidated if the viewer's boundaries change or if the record associations for that blob are updated.

### Performance Optimization

To ensure a performant authorization layer, we will implement the following:

- **Boundary Caching**: Viewer boundaries resolved via `BoundaryResolver` should be cached (TTL-based).
- **Blob-Record Mapping**: The `stratos_record_blob` table already provides a fast lookup from `blobCid` to `recordUri`.
- **Pre-computed Accessibility**: For frequently accessed blobs, we can cache the result of the boundary intersection.
- **Short-circuit for Public Data**: If a blob is referenced by a record with no boundaries (if supported) or a "public" boundary, skip complex checks.

### Schema Considerations

The existing `stratos_record_blob` table in the actor store is sufficient:

```sql
CREATE TABLE stratos_record_blob (
  blobCid TEXT NOT NULL,
  recordUri TEXT NOT NULL,
  PRIMARY KEY (blobCid, recordUri)
);
```

We can join this with `stratos_record` to get the records, then extract boundaries from the record values.
_Note: If boundary extraction from record values is too slow, we may consider denormalizing boundaries into a `stratos_record_boundary` table._

## Implementation Plan

1.  **Stratos-Core**:
    - Add `BlobAuthService` interface and implementation.
    - Update `BlobMetadataReader` if needed for batch boundary lookups.
2.  **Stratos-Service**:
    - Implement `com.atproto.sync.getBlob` handler in `src/api/handlers/`.
    - Integrate `BlobAuthService` into the XRPC handler.
    - Add caching layer for boundaries.
3.  **Stratos-Client**:
    - Update client to support blob fetching.
    - Update documentation.

## Questions & Considerations

1.  **Orphaned Blobs**: How should we handle blobs that are uploaded but not yet referenced by any record? Currently, ATProtocol allows "unattached" blobs for a period. In a private-first service like Stratos, should we allow downloading unattached blobs, or only if the uploader is the viewer?
2.  **Performance vs. Strictness**: Is denormalizing boundaries into a separate table worth the storage overhead for faster `getBlob` authorization?
3.  **Boundary Resolution**: Should we support a "service-wide" boundary cache to avoid re-resolving boundaries for the same viewer across different actor requests?
