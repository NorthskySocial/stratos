# Private feed attachments

The feed generator reads Stratos-hosted attachments on demand and caches verified bytes on its local disk.
Repeated reads avoid another upstream download. A CDN is not required for this benefit.
An S3 cache is not required: the local cache has explicit byte and retention limits and can be discarded.
The `BlobCache` interface separates storage from authorization and download integrity checks.

## Feed response

`zone.stratos.feedgen.getFeed` preserves each signed `post.record`, its blob refs, and the post CID.
It adds a `post.blobs` view for attachments the feed generator can serve:

```json
{
  "cid": "bafkreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa",
  "mimeType": "image/png",
  "url": "https://feedgen.example/xrpc/zone.stratos.feedgen.getBlob?uri=at%3A%2F%2Fdid%3Aplc%3Afaye%2Fzone.stratos.feed.post%2Fone&cid=bafkreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa"
}
```

Match a view to the record attachment by CID. Do not replace the record's CID with a URL.
Use `post.author.did` for attribution. Space record URIs start with the space authority, not the author.

The cache transport currently supports **Stratos custody**. It does not discover or download blobs from arbitrary PDS hosts.
PDS-custody posts, and space posts without a current custody snapshot, have no feedgen blob view.
Clients retain their existing host read path for those records. The example webapp retains its authenticated Stratos-agent path.
Availability on that path still depends on the host's blob support; a feedgen view does not claim to add PDS blob support.
Clubhouse currently renders post text only and does not render attachments.

## Authenticated downloads

The new Lexicon XRPC query is `zone.stratos.feedgen.getBlob` with required `uri` and `cid` parameters.
`uri` identifies the exact indexed post that references the blob, including seven-segment space record URIs.
The request requires a viewer service-auth JWT with the feedgen audience and `lxm=zone.stratos.feedgen.getBlob`.
A token issued for `getFeed` cannot call `getBlob`, and vice versa.

Add `rpc:zone.stratos.feedgen.getBlob?aud=*` to OAuth client metadata and the requested scopes.
`buildStratosScopes()` includes this scope. Existing sessions need to authorize the new scope.
The webapp metadata template and image loader include the new method.

An authenticated image URL cannot be placed directly in `<img src>`.
Send the query through the user's authenticated PDS proxy, then render a local object URL:

```typescript
const parameters = new URLSearchParams({ uri: post.uri, cid: attachment.cid })
const response = await session.fetchHandler(
  `/xrpc/zone.stratos.feedgen.getBlob?${parameters}`,
  {
    method: 'GET',
    headers: { 'atproto-proxy': `${feedgenDid}#stratos_feedgen` },
  },
)
if (!response.ok) throw new Error('Private attachment is unavailable')
const objectUrl = URL.createObjectURL(await response.blob())
// Render objectUrl locally. Revoke it when the image is removed or the session ends.
URL.revokeObjectURL(objectUrl)
```

Construct the XRPC path from the post URI and CID, not from an untrusted attachment URL.
Never place an access token in a URL. A denied feedgen request must not trigger an anonymous fallback.

## Authorization and retention

Every request, including a cache hit, checks the current viewer boundaries against the indexed post boundaries.
The blob CID must still be attached to that post. Record-supplied boundary claims do not grant access.
The handler checks again after the download. A purge, custody change, or reconciliation transition prevents the bytes from being returned.
Cached content is keyed by indexed author DID and CID. Raw SHA-256 CIDs are verified before caching and on cache hits.
The upstream request has a timeout. Declared content length and the bytes actually received are bounded.

Responses use `Cache-Control: private, no-store`, `Vary: Authorization`, `nosniff`, a sandbox CSP, and attachment disposition.
Known passive image, video, and audio types keep their MIME type; other content is `application/octet-stream`.
There is no public cache URL, range response, redirect, or CDN authorization bypass.

Purging a post removes its blob authorization immediately; a retained cache file does not grant access.
Cached bytes can remain on disk until eviction, expiry on access, or the next startup scan.
The TTL is not a scheduled secure-erasure guarantee. Existing local object URLs also require client cleanup after sign-out or removal.
Use a dedicated cache directory per feedgen process. Protect its volume as private data.
The container image uses `/app/cache/blobs`, outside the durable control volume.
That cache is ephemeral unless an operator mounts a separate private cache volume.
Deleting the cache directory while the service is stopped is safe; subsequent requests refill it.

| Environment variable                    | Default                | Purpose                                                             |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `FEEDGEN_BLOB_CACHE_DIRECTORY`          | `./data/feedgen-blobs` | Dedicated private disk cache                                        |
| `FEEDGEN_BLOB_CACHE_MAX_BYTES`          | `536870912` (512 MiB)  | Total retained cache bytes; least recently read entries are evicted |
| `FEEDGEN_BLOB_CACHE_TTL_MS`             | `3600000` (one hour)   | Maximum entry age before reuse; reads do not extend it              |
| `FEEDGEN_BLOB_MAX_BYTES`                | `26214400` (25 MiB)    | Maximum accepted attachment size                                    |
| `FEEDGEN_BLOB_MAX_CONCURRENT_DOWNLOADS` | `4`                    | Maximum simultaneous upstream downloads                             |

A blob exceeding the object limit returns `BlobTooLarge`. Saturated download capacity returns `BlobBusy` (503).
An inaccessible, unattached, missing, or unsupported-custody blob returns `BlobNotFound`.
While authorization is reconciling, requests return `FeedNotReady` (503).
Download failures and CID mismatches are not cached. Clients can retry after readiness or upstream service recovers.
