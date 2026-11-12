# Private feed attachments

A private post can carry a photo. The photo is as private as the post. So
the feed generator hands it out the same way it hands out the post: it checks
who is asking, then checks that the photo still belongs to a post they can
read.

The feed generator downloads an attachment from Stratos when a viewer first
asks for it. It checks the file against its content ID (CID) and keeps a
temporary copy in memory, never on disk. Later requests can use that copy.

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

### Which posts have attachments here

The feed generator serves attachments only for posts that Stratos hosts.
Those posts have a three-segment URI: `at://{authorDid}/{collection}/{rkey}`.

A post that a member's own PDS hosts has a seven-segment space record URI.
Its `post.blobs` field is absent. `getBlob` answers `BlobNotFound` for every
seven-segment URI. Read those files from the host PDS, through that host's
authenticated file-read path, if the host supports it.

So the rule for a client is short. If `post.blobs` is present, use it. If it
is absent, do not call `getBlob` for that post.

## Authenticated downloads

Call `zone.stratos.feedgen.getBlob` with the post's `uri` and the attachment's
`cid`. Send the post URI exactly as the feed returned it.

The request needs a service-auth token for the feed generator. Mint it with
`lxm=zone.stratos.feedgen.getBlob`. Mint a separate token with
`lxm=zone.stratos.feedgen.getFeed` for feed requests. Always match `lxm` to
the method you call.

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

Every request checks the viewer's membership and confirms that the post still
includes the attachment's CID. This happens even when the file is already in
memory. The viewer must hold a boundary that is both on the post and behind a
configured feed. A boundary claimed inside the post does not grant access.

The feed generator checks again after the download. A deletion or a
membership change during the download stops the file from being returned. It
verifies SHA-256 CIDs before it stores or reuses a file. It limits download
time to 10 seconds and file size to 4 MiB.

Responses use `Cache-Control: private, no-store`, `Vary: Authorization`, `nosniff`, a sandbox CSP, and attachment disposition.
Known passive image, video, and audio types keep their MIME type; other content is `application/octet-stream`.
There is no public cache URL, range response, redirect, or CDN authorization bypass.

Once the feed generator processes a post deletion, it removes permission to
download its attachments.
The memory cache can hold up to 16 MiB across 128 files, for at most five
minutes, with a 4 MiB limit per file. At most two downloads run at once.
Expired files are removed and the cache disappears when the process stops;
this does not guarantee secure erasure from memory. Browsers must still
revoke local object URLs after sign-out or removal. The older TypeScript
`FEEDGEN_BLOB_CACHE_*` settings do not apply to the current feed generator.

## Errors

| Status | Error            | Cause                                                                                                                  |
| ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 401    | Token errors     | The service-auth token is missing or invalid. See the [operator page](/operator/feedgen-ng#request-limits-and-errors). |
| 400    | `InvalidRequest` | `uri` or `cid` is missing, `uri` is over 2,048 bytes, or `cid` is over 256 bytes                                       |
| 400    | `BlobNotFound`   | The URI is a seven-segment space record URI                                                                            |
| 400    | `BlobNotFound`   | The post is not indexed, or the viewer holds none of its feed boundaries                                               |
| 400    | `BlobNotFound`   | The post does not reference that CID                                                                                   |
| 400    | `BlobTooLarge`   | The file is over 4 MiB                                                                                                 |
| 503    | `BlobBusy`       | Two downloads are already running                                                                                      |
| 503    | `FeedNotReady`   | The feed generator is still checking membership after startup or a disconnect                                          |
| 503    | `FeedNotReady`   | The viewer has no enrollment, or the request limit is reached                                                          |
| 503    | `FeedNotReady`   | Stratos did not return the file, or the post changed during the download                                               |

`BlobNotFound` does not say which cause applied. A viewer cannot use it to
learn whether a post exists.

Retry a `503` after a short wait. Do not retry a `400`. Failed downloads and
files with the wrong CID are not cached.
