# Deployment

Standing up Stratos is like opening a venue. You need an address people can
find, a door that locks, and one person with the keys before anyone arrives.
This page takes you through those steps in order.

## Prerequisites

- **Linux with `flock` installed** (`apk add flock` on Alpine, or `apt install util-linux` on Debian/Ubuntu). The Docker image includes it. The service identity directory must use a local filesystem supporting file locks, atomic rename, and directory fsync; see [service signing key history](/architecture/service-key-history).
- **Node.js 24** and **pnpm**. The Docker image builds and runs on Node.js 24.
- **A domain with HTTPS.** OAuth callbacks need it.
- **A `did:web` identifier** for the service, on that domain.
- **Your own DID.** You need it to become the first admin.

## Step 1: Clone and build

```bash
git clone https://github.com/NorthskySocial/stratos.git
cd stratos
pnpm install
pnpm build
```

The build also produces the admin interface.

## Step 2: Choose the service DID

A `did:web` identifier is the domain name: `did:web:stratos.example.com`.

You do not write the DID document. Stratos generates its signing key on the
first start and serves the document at `/.well-known/did.json`. Route that
path to the service so a key rotation updates the public document.

The document has this shape:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:web:stratos.example.com",
  "verificationMethod": [
    {
      "id": "did:web:stratos.example.com#atproto_pns",
      "type": "Multikey",
      "controller": "did:web:stratos.example.com",
      "publicKeyMultibase": "zQ3sh..."
    },
    {
      "id": "did:web:stratos.example.com#atproto",
      "type": "Multikey",
      "controller": "did:web:stratos.example.com",
      "publicKeyMultibase": "zQ3sh..."
    }
  ],
  "service": [
    {
      "id": "#stratos",
      "type": "StratosService",
      "serviceEndpoint": "https://stratos.example.com"
    }
  ]
}
```

Both entries carry the same key. The first uses `STRATOS_SERVICE_FRAGMENT`.
The `#atproto` entry lets a member's PDS verify the space credentials Stratos
issues.

## Step 3: Configure the environment

Create a `.env` file:

```bash
# Service identity
STRATOS_SERVICE_DID="did:web:stratos.example.com"
STRATOS_PUBLIC_URL="https://stratos.example.com"
STRATOS_PORT=3100

# Storage
STRATOS_DATA_DIR="/var/lib/stratos/data"
STORAGE_BACKEND="sqlite"
STRATOS_BLOB_STORAGE="local"

# Replay store and cache
STRATOS_VALKEY_URL="redis://localhost:6379"

# Enrollment
STRATOS_ENROLLMENT_MODE="allowlist"
STRATOS_ALLOWED_DIDS="did:plc:abc123,did:plc:def456"

# First admin
STRATOS_ADMIN_DIDS="did:plc:abc123"

# Boundaries created on the first start
STRATOS_ALLOWED_DOMAINS="general,writers"
STRATOS_AUTO_ENROLL_DOMAINS="general"

LOG_LEVEL="info"
```

Set `STRATOS_ADMIN_DIDS` before the first start. Without an admin, nobody can
open the admin interface.

`STRATOS_ALLOWED_DOMAINS` and `STRATOS_AUTO_ENROLL_DOMAINS` create your first
boundaries. After the first start you manage boundaries in the admin interface,
and these two settings are ignored.

See [Configuration](/operator/configuration) for every variable.

## Step 4: Check the OAuth client metadata

Stratos generates and serves its own OAuth client metadata. You do not host a
file. After the service starts, the document is at
`https://stratos.example.com/client-metadata.json`:

```json
{
  "client_id": "https://stratos.example.com/client-metadata.json",
  "client_name": "Stratos Service",
  "client_uri": "https://stratos.example.com",
  "redirect_uris": [
    "https://stratos.example.com/oauth/callback",
    "https://stratos.example.com/admin/oauth/callback"
  ],
  "scope": "atproto repo:zone.stratos.actor.enrollment space:zone.stratos.space.feed?authority=did%3Aweb%3Astratos.example.com&collection=zone.stratos.feed.post&action=create&action=read",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}
```

The scope asks for two things. `repo:zone.stratos.actor.enrollment` lets
Stratos publish the enrollment record. The `space:` scope lets a spaces PDS
keep the member's posts. A PDS without spaces support ignores that scope.

Both redirect URIs come from `STRATOS_PUBLIC_URL`. Your proxy must route
`/oauth/*` and `/admin/*` to the service.

## Step 5: Run the service

Run the service from the `stratos-service` directory:

```bash
cd stratos-service
node dist/bin/stratos.js
```

Use your process manager of choice to keep it running. Run one Stratos process
for each service DID. See [Scaling](/operator/operations#scaling).

To run with Docker instead, see [Deployment Examples](/operator/examples/).

## Step 6: Verify the deployment

```bash
# Health check
curl https://stratos.example.com/health
# {"status":"ok","components":{"db":"ok","blobstore":"ok"},"version":"0.3.1"}

# DID document
curl https://stratos.example.com/.well-known/did.json

# Enrollment status for one DID
curl "https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=did:plc:abc123"
```

Then open `https://stratos.example.com/admin/` and sign in with the account you
listed in `STRATOS_ADMIN_DIDS`. Check the **Boundaries** tab for the boundaries
you configured.

## Add the Feed Generator

To serve private feeds, deploy the Rust `stratos-feedgen-ng` service with its
own DID, signing key, feed list, and encrypted data volume. Do not reuse the
older TypeScript feed generator's database. See [Feed Generator](/operator/feedgen-ng)
for how it collects posts, checks membership, and protects local data.

> Before startup, the feed generator's `did:web` **must be under the
> Stratos-controlled space domain**. For example, if Stratos uses
> `did:web:stratos.example.com`, set
> `FEEDGEN_SERVICE_DID=did:web:feeds.stratos.example.com` and
> `FEEDGEN_PUBLIC_URL=https://feeds.stratos.example.com`. Configure DNS,
> HTTPS, and routing for that host. Grant the same DID service membership in
> each feed boundary through Stratos Enrollments; a feed registry entry alone
> grants no access. After startup, check the feed host's
> `/.well-known/did.json` and make an authenticated feed request.

Start it with a separate, empty database and test an authenticated feed request
before changing traffic routing. Follow `stratos-feedgen-ng/CUTOVER.md` for
comparison and rollback.
