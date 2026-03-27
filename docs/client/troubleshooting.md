# Troubleshooting

## "NotEnrolled" After Completing OAuth

The Stratos service may have an allowlist. Contact the service operator to request access. You can verify the current enrollment status directly:

```bash
curl "https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=<your-did>"
```

## Posts Not Appearing in Feed

1. Check that the post's boundary domains match at least one of the viewer's enrolled domains.
2. Verify the AppView has indexed the Stratos content — indexing can lag by a few seconds.
3. Confirm the post was created successfully by checking the returned AT-URI.

## OAuth Redirect Fails

1. Verify your app's callback URL is listed in the Stratos `redirect_uris` configuration.
2. Check for CORS errors in the browser console.
3. Ensure the user's PDS supports ATProtocol OAuth.

## Requests Go to PDS Instead of Stratos

You're likely using `new Agent(session)` and then trying to override `serviceUrl`. Use the fetch handler wrapper instead — see [Getting Started](/client/getting-started#3-create-a-stratos-agent).

## Rate Limiting (429 errors)

Implement exponential backoff. The default rate limit is 300 writes per 60-second window per DID. If you're building a bulk import tool, use `zone.stratos.repo.importRepo` instead of individual `createRecord` calls.

## DPoP Nonce Errors

If you receive `use_dpop_nonce` errors, extract the nonce from the `DPoP-Nonce` response header and include it in the next request's DPoP proof. Ensure `DPoP-Nonce` is listed in your nginx/proxy `Access-Control-Expose-Headers`.

## Record Returns 404 for Enrolled User

The viewer may not share a boundary with the record. Stratos returns 404 (not 403) for boundary access failures to avoid leaking record existence.
