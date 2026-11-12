# Security

A boundary is a locked room. Stratos stands at every door and checks the
caller on every request. It never trusts a note the caller wrote about
themselves. This page lists which door asks for which proof, and what you must
protect as the operator.

## Authentication reference

| Endpoint                                                | Auth required | Auth type                                    |
| ------------------------------------------------------- | ------------- | -------------------------------------------- |
| `/oauth/authorize`, `/oauth/callback`                   | No            | Public enrollment flow                       |
| `/health`, `/ready`, `/.well-known/did.json`            | No            | Public                                       |
| `zone.stratos.enrollment.status`                        | Optional      | Anonymous callers get a reduced answer       |
| `zone.stratos.server.listRooms`                         | No            | Public list of listed rooms                  |
| `zone.stratos.identity.getKeyHistory`                   | No            | Public service key history                   |
| `createRecord`, `deleteRecord`, `applyWrites`           | Yes           | Member OAuth access token with DPoP          |
| `uploadBlob`                                            | Yes           | Member OAuth access token with DPoP          |
| `getRecord`, `listRecords`                              | Optional      | The caller's boundaries filter the result    |
| `com.atproto.sync.getBlob`, `zone.stratos.sync.getBlob` | Optional      | Anonymous callers are always denied          |
| `zone.stratos.repo.hydrateRecord`, `hydrateRecords`     | Optional      | Member OAuth token or space credential       |
| `zone.stratos.sync.getRepo`                             | Yes           | Member OAuth token. Repository owner only    |
| `zone.stratos.enrollment.unenroll`                      | Yes           | Member OAuth token                           |
| `zone.stratos.sync.subscribeRecords`                    | Yes           | Service-auth token from a service enrollment |
| `zone.stratos.sync.listBoundaries`                      | Yes           | Service-auth token from a service enrollment |
| `zone.stratos.sync.listRepoOps`, `listRecordPaths`      | Yes           | Service-auth token or space credential       |
| `zone.stratos.space.getSpaceCredential`                 | Yes           | Member OAuth token or a signed delegation    |
| `zone.stratos.space.getRecord`, `listBlobs`             | Yes           | Member OAuth token or space credential       |
| `zone.stratos.space.listRepos`                          | Yes           | Service-auth token or space credential       |
| `zone.stratos.admin.*`                                  | Yes           | Admin session cookie                         |

Stratos does not serve `com.atproto.sync.getRecord` or
`zone.stratos.repo.importRepo`.

## Boundary enforcement

Stratos validates every write:

- The record must carry exactly one boundary.
- The boundary must belong to this service. Another service's boundary is
  rejected with `ServiceMismatch`.
- The author must be a member of that boundary. Otherwise the write is
  rejected with `ForbiddenBoundary`.
- A Stratos post cannot embed or reply to a record from another namespace,
  such as `app.bsky`.

Stratos checks every read against the caller's current boundaries. The viewer
is always the authenticated caller. No read endpoint accepts a viewer DID from
the request.

A denied read does not reveal the record:

| Endpoint                           | Denied read returns                                     |
| ---------------------------------- | ------------------------------------------------------- |
| `com.atproto.repo.getRecord`       | HTTP 400 `RecordNotFound`, the same as a missing record |
| `com.atproto.repo.listRecords`     | The record is left out of the list                      |
| `zone.stratos.repo.hydrateRecord`  | HTTP 400 `RecordBlocked`                                |
| `zone.stratos.repo.hydrateRecords` | The URI is listed in `blocked`                          |
| `getBlob`                          | HTTP 400 `BlobBlocked`                                  |

The two hydration endpoints tell the caller that a record exists and is
blocked. Use `getRecord` when existence itself must stay hidden.

Boundaries on records that a member's own PDS hosts need extra care. See
[Mixed-mode custody](/operator/architecture#mixed-mode-custody).

## Service identities

A sync consumer, such as the feed generator, needs a service enrollment. You
declare it in `STRATOS_SERVICE_ENROLLMENTS` and manage its boundaries in the
admin interface. See
[Service enrollments](/operator/configuration#service-enrollments).

- A service identity reads only within its own boundaries.
- A service identity cannot write. `createRecord` rejects it with
  `ServiceWriteForbidden`.
- A service identity without any boundary cannot open the sync stream.
- An open stream closes when the identity's membership changes.

Grant each service identity the fewest boundaries it needs. There is no
separate allow list for sync consumers.

## Admin access

Admin access uses OAuth and a server-side session. There is no admin password.
See [Admin authorization](/operator/configuration#admin-authorization).

- Keep `STRATOS_ADMIN_DIDS` short. Those DIDs cannot be revoked from the
  interface.
- The session cookie is HttpOnly and `SameSite=Strict`. A session expires
  after 12 hours.
- Stratos rejects an admin request whose origin is not the service's own.
- Serve the admin interface over HTTPS only.

## Member tokens

Stratos validates the DPoP proof on each member request and checks that the
access token is bound to the proof key. It does not verify the access token's
own signature. See
[DPoP authentication](/operator/configuration#dpop-authentication).

Never set `STRATOS_DEV_MODE=true` in production. It accepts a bare DID as a
credential.

## Rate limiting

Stratos has one built-in limit: writes per DID. A throttled write returns
HTTP 429 `RateLimitExceeded`. See
[Write rate limiter](/operator/configuration#write-rate-limiter).

Stratos does not limit reads or OAuth requests. Add those limits at your
reverse proxy. These values are a starting point:

| Endpoint           | Limit              |
| ------------------ | ------------------ |
| `getRecord`        | 1000/minute per IP |
| `/oauth/authorize` | 10/minute per IP   |

## CORS

Stratos sets its own CORS headers. Do not add or replace them at the proxy.

| Header                          | Value                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Access-Control-Allow-Origin`   | The request origin                                                                                                                   |
| `Access-Control-Allow-Methods`  | `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`, `HEAD`                                                                                    |
| `Access-Control-Allow-Headers`  | `Authorization`, `Content-Type`, `DPoP`, `DPoP-Nonce`, `Signature`, `Signature-Input`, `Atproto-Space-Audience`, and tracing headers |
| `Access-Control-Expose-Headers` | `DPoP-Nonce`, `WWW-Authenticate`, `x-trace-id`                                                                                       |

Only the service's own origin receives `Access-Control-Allow-Credentials`. No
other site can use the admin session cookie.

A proxy only forwards the request. It must pass these headers through
unchanged:

```nginx
location / {
    proxy_pass http://stratos:3100;
    # Sync stream
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

A browser client needs `DPoP-Nonce` exposed to complete the nonce retry. A
proxy that strips or overrides the CORS headers breaks it.

## Signing key security

The service key lives in `{STRATOS_DATA_DIR}/service-signing-identity.json`.
Stratos writes it with file mode `0600`. Keep the data directory owned by the
service user:

```bash
chown -R stratos:stratos /var/lib/stratos/data
chmod 700 /var/lib/stratos/data
```

Never delete `service-signing-identity.lock`. Editing the old `signing_key`
file does not rotate the key.

Rotate with the offline `stratos-rotate-service-key` command. If the key is
compromised, rotate at once. See
[Service signing key history](/architecture/service-key-history).

With the `sqlite` backend, each member's P-256 key is a file under
`actors/`. With the `postgres` backend, member keys are in the database.
Protect both like the service key.
