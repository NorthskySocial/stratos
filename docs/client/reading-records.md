# Read Records

## Direct private reads

Route repository reads to Stratos with the authenticated OAuth fetch handler. Stratos derives the viewer from the credential and checks current shared boundaries.

An unauthorized request returns a not-found response. This avoids exposing the existence of a private record.

## Hydration

`zone.stratos.repo.hydrateRecord` and `zone.stratos.repo.hydrateRecords` return records that the caller may read. Batch hydration returns successful records and reports inaccessible or missing subjects separately.

The returned `source` field identifies the authoritative Stratos repository subject. It lets a client follow the record to the service that owns it.

## Feed generator reads

For a configured feed, route a proxied request through the user PDS. The PDS-issued service-auth token identifies the viewer to the feed generator. The feed generator serves its local projection only after authorization is current.

The feed generator returns hydrated records. Do not treat it as a public skeleton endpoint or rely on a client-side filter to protect record content.

## Verify content when required

For stronger verification, obtain an inclusion proof with `com.atproto.sync.getRecord`. Verify the record CID, signed commit, and the enrolled user signing key. A matching source CID alone shows internal consistency; it does not prove the origin of a service response.
