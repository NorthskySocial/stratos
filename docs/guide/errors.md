# Error Code Registry

This page documents the standard error codes returned by the Stratos service and how they map to HTTP status codes.

## Standard Errors

Stratos uses custom error codes in the `code` field of XRPC error responses.

| Code                | HTTP Status           | Description                                                              |
| ------------------- | --------------------- | ------------------------------------------------------------------------ |
| `NotEnrolled`       | 403 Forbidden         | The user is not enrolled with this Stratos service.                      |
| `EnrollmentDenied`  | 403 Forbidden         | The enrollment request was denied (e.g., not in allowlist).              |
| `ForbiddenBoundary` | 400 Bad Request       | The requested boundary is not allowed or the user is not a member.       |
| `RecordNotFound`    | 404 Not Found         | The record does not exist OR the viewer does not have access.            |
| `InvalidIdentifier` | 400 Bad Request       | The provided DID, URI, or CID is malformed.                              |
| `MstError`          | 500 Internal Error    | An error occurred during MST (Merkle Search Tree) repository operations. |
| `InvalidDpop`       | 401 Unauthorized      | The DPoP proof is invalid or missing.                                    |
| `RateLimitExceeded` | 429 Too Many Requests | The user has exceeded the service's write rate limits.                   |

## Enrollment Denial Reasons

When an `EnrollmentDenied` error occurs, the response may include a more specific reason:

- `NotInAllowlist`: The user's DID or PDS is not on the service's allowlist.
- `DidNotResolved`: The user's DID could not be resolved.
- `PdsEndpointNotFound`: The user's PDS endpoint could not be found in their DID document.
- `ServiceClosed`: The service is currently not accepting new enrollments.

## Access Control & 404s

Stratos intentionally returns `404 Not Found` instead of `403 Forbidden` for records that the viewer is not authorized to see. This prevents "metadata leakage" where an unauthorized user could confirm the existence of a private record by seeing a 403 error.

## Client Handling

If you are using the Stratos client library, these errors are typically thrown as `StratosError` objects.

```typescript
try {
  await client.com.atproto.repo.createRecord(...)
} catch (err) {
  if (err.code === 'NotEnrolled') {
    // Prompt user to enroll
  } else if (err.code === 'RateLimitExceeded') {
    // Implement backoff
  }
}
```
