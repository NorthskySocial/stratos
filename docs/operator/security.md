# Security

## Authentication Reference

| Endpoint                       | Auth Required | Auth Type                   |
| ------------------------------ | ------------- | --------------------------- |
| `/oauth/*`                     | No            | Public enrollment flow      |
| `createRecord`, `deleteRecord` | Yes           | OAuth access token (DPoP)   |
| `getRecord`, `listRecords`     | Optional      | Used for boundary filtering |
| `sync.getRecord`               | Yes           | User or service auth        |
| `sync.getRepo`                 | Yes           | User auth (owner only)      |
| `importRepo`                   | Yes           | User auth (owner only)      |
| `subscribeRecords`             | Yes           | Service auth JWT            |
| `/_health`                     | No            | Public health check         |

## Boundary Enforcement

Records are validated on write:

- Boundary domains must be in `STRATOS_ALLOWED_DOMAINS`.
- Cross-namespace embeds are rejected (no `app.bsky` references in Stratos records).

On read, `getRecord` checks whether the requesting DID shares at least one boundary with the record.
Access-denied responses are returned as 404 to avoid leaking record existence.

## Rate Limiting

Recommended per-endpoint limits:

| Endpoint        | Limit               |
| --------------- | ------------------- |
| `createRecord`  | 100/minute per user |
| `getRecord`     | 1000/minute per IP  |
| OAuth authorize | 10/minute per IP    |

The built-in write rate limiter applies per-DID throttling.
See [Configuration](/operator/configuration#write-rate-limiter) for tuning.

## CORS Configuration

**Required exposed headers:** `DPoP-Nonce`, `WWW-Authenticate`

These must be in `Access-Control-Expose-Headers` for DPoP nonce negotiation to work correctly from
browser clients.

Example nginx configuration:

```nginx
location / {
    proxy_hide_header Access-Control-Allow-Origin;

    add_header Access-Control-Allow-Origin "https://your-webapp.example.com" always;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, DELETE" always;
    add_header Access-Control-Allow-Headers "Authorization, DPoP, Content-Type" always;
    add_header Access-Control-Expose-Headers "DPoP-Nonce, WWW-Authenticate" always;

    if ($request_method = OPTIONS) {
        return 204;
    }

    proxy_pass http://stratos:3100;
}
```

## Signing Key Security

The service secp256k1 signing key is stored at `{dataDir}/signing_key`. Protect this file:

```bash
chmod 600 /var/lib/stratos/data/signing_key
chown stratos:stratos /var/lib/stratos/data/signing_key
```

If the key is compromised, all existing attestations will need to be reissued. Rotate by replacing
the key file and re-running enrollment for all users.

## AppView Allowlist

Only AppViews listed in `STRATOS_ALLOWED_APPVIEWS` can call `subscribeRecords` with service auth.
Keep this list minimal:

```bash
STRATOS_ALLOWED_APPVIEWS="did:web:appview.example.com"
```
