# Deployment

## Prerequisites

- **Node.js 20+**
- **pnpm** (package manager)
- **Domain with HTTPS** (for OAuth callbacks)
- **DID** for the service (`did:web` or `did:plc`)

## Step 1: Clone and Build

```bash
git clone https://github.com/NorthskySocial/stratos.git
cd stratos
pnpm install
pnpm build
```

## Step 2: Create Service DID

For `did:web`, create a `.well-known/did.json` at your domain:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:web:stratos.example.com",
  "verificationMethod": [
    {
      "id": "did:web:stratos.example.com#atproto",
      "type": "Multikey",
      "controller": "did:web:stratos.example.com",
      "publicKeyMultibase": "zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF"
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

## Step 3: Configure Environment

Create a `.env` file:

```bash
# Service Identity
STRATOS_SERVICE_DID="did:web:stratos.example.com"
STRATOS_SERVICE_FRAGMENT="atproto_pns"
STRATOS_PORT=3100
STRATOS_PUBLIC_URL="https://stratos.example.com"

# Storage
STRATOS_DATA_DIR="/var/lib/stratos/data"
STORAGE_BACKEND="sqlite"

# Blob Storage
STRATOS_BLOB_STORAGE="local"

# Identity Resolution
STRATOS_PLC_URL="https://plc.directory"

# Enrollment
STRATOS_ENROLLMENT_MODE="allowlist"
STRATOS_ALLOWED_DIDS="did:plc:abc123,did:plc:def456"

# OAuth
STRATOS_OAUTH_CLIENT_ID="https://stratos.example.com/client-metadata.json"
STRATOS_OAUTH_REDIRECT_URI="https://stratos.example.com/oauth/callback"

# Boundaries
STRATOS_ALLOWED_DOMAINS="general,writers"

# AppViews
STRATOS_ALLOWED_APPVIEWS="did:web:appview.example.com"

STRATOS_LOG_LEVEL="info"
```

See [Configuration](/operator/configuration) for all available variables.

## Step 4: Create OAuth Client Metadata

Host this JSON at `https://stratos.example.com/client-metadata.json`:

```json
{
  "client_id": "https://stratos.example.com/client-metadata.json",
  "client_name": "Stratos Private Namespace Service",
  "client_uri": "https://stratos.example.com",
  "redirect_uris": ["https://stratos.example.com/oauth/callback"],
  "scope": "atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}
```

## Step 5: Run the Service

```bash
# Direct
node dist/bin/stratos.js

# With PM2
pm2 start dist/bin/stratos.js --name stratos

# With systemd
sudo systemctl start stratos
```

## Step 6: Verify Deployment

```bash
# Health check
curl https://stratos.example.com/health
# {"status":"ok","version":"0.1.0"}

# DID document
curl https://stratos.example.com/.well-known/did.json

# Check enrollment status
curl "https://stratos.example.com/xrpc/zone.stratos.enrollment.status?did=did:plc:abc123"
```
