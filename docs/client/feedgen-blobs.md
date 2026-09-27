# Private feed attachments

The feed generator downloads attachments from Stratos when needed. It checks
each file against its content ID (CID) and keeps a temporary copy in memory,
not on disk. Repeated requests can use that copy instead of downloading the
file again.

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

This attachment path works only for files hosted by Stratos. The feed
generator does not download files from arbitrary PDSs. For posts hosted on a
PDS, clients must use that host's existing authenticated file-read path, if
the host supports it.

## Authenticated downloads

Call `zone.stratos.feedgen.getBlob` with the post's `uri` and the attachment's
`cid`. Use the full post URI, including all seven segments for a space post.
The request needs a signed service token for the feed generator with
`lxm=zone.stratos.feedgen.getBlob`. A token for `getFeed` cannot download an
attachment.

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

Every request checks the viewer's current membership and confirms that the
post still includes the attachment's CID, even when the file is in memory.
A boundary claimed inside the post does not grant access. The service checks
again after downloading, so a deletion, hosting change, or membership change
can stop the file from being returned. It verifies SHA-256 CIDs before storing
or reusing a file, and limits download time and file size.

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

A file over 4 MiB returns `BlobTooLarge`. If two downloads are already running,
the service returns `BlobBusy` (503). A missing file, one not attached to the
post, or one hosted on an unsupported PDS returns `BlobNotFound`. While the
service checks membership after startup or a disconnect, it returns
`FeedNotReady` (503). Failed downloads and files with the wrong CID are not
cached; clients can retry when the service is ready.
