# Configuration

Configure the Stratos service and feed generator independently. Keep secrets outside source control.

## Stratos service

The service requires its public URL and DID, OAuth configuration, storage backend, signing configuration, and boundary policy. Read the service deployment configuration with the source package when you change an environment variable. The configuration boundary is the service process, not the PDS.

Use fully qualified boundaries in client requests. Operators configure the boundary names that the service qualifies with its DID at startup.

## Feed generator

The feed generator requires these values:

| Variable                                     | Purpose                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `FEEDGEN_SERVICE_DID`                        | Feed generator service DID.                                         |
| `FEEDGEN_SIGNING_KEY`                        | Private signing key for service-auth requests and the DID document. |
| `FEEDGEN_PUBLIC_URL`                         | Public HTTPS endpoint. Defaults from the DID when supported.        |
| `STRATOS_SERVICE_URL`                        | Stratos service endpoint.                                           |
| `STRATOS_SERVICE_DID`                        | Authoritative Stratos service DID.                                  |
| `FEEDGEN_FEEDS_FILE` or `FEEDGEN_FEEDS_JSON` | Static feed definitions and their boundaries.                       |
| `FEEDGEN_STORAGE_BACKEND`                    | `sqlite` or `postgres`.                                             |
| `FEEDGEN_SQLITE_PATH`                        | SQLite projection path when SQLite is selected.                     |
| `FEEDGEN_POSTGRES_URL`                       | Postgres URL when Postgres is selected.                             |
| `FEEDGEN_METRICS_TOKEN`                      | Optional bearer token for `/metrics`.                               |

Space synchronization is opt-in. Set `FEEDGEN_SPACE_SYNC_ENABLED=true` only after you configure the related membership and request-limit settings. Its limits protect the feed generator from oversized pages, excessive records, and slow members.

Never publish `FEEDGEN_SIGNING_KEY`, OAuth client secrets, access tokens, or database credentials.
