---
audience: Operators
type: Reference
status: current
---

# Environment variables

Every environment variable the Stratos service reads. Stratos reads them once,
at startup. An invalid value stops the service and prints the variable name.
Only `STRATOS_SERVICE_DID` has no default.

[Configuration](/operator/configuration) explains how the settings fit
together. The feed generator has its own variables. They are listed in
[Run the feed generator](/operator/feedgen-ng#configuration-reference).

<EnvTable />

## Variables that do nothing

Stratos accepts these variables but no code reads them. Setting them has no
effect.

| Variable                                     | Note                                               |
| -------------------------------------------- | -------------------------------------------------- |
| `STRATOS_SIGNING_KEY_HEX`                    | The service key lives in the signing identity file |
| `STRATOS_RETENTION_DAYS`                     | No retention sweep uses it                         |
| `STRATOS_IMPORT_MAX_BYTES`                   | The service does not register a repository import  |
| `STRATOS_DPOP_REQUIRE_NONCE`                 | Nonce handling does not consult it                 |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Use `STRATOS_VALKEY_URL`                           |

These names appear in older guides and do not exist: `STRATOS_OAUTH_REDIRECT_URI`,
`STRATOS_ALLOWED_APPVIEWS`, `STRATOS_LOG_LEVEL`, and `STRATOS_PLC_URL`.
`STRATOS_SYNC_TOKEN` and `BSKY_DB_POSTGRES_URL` belong to the deprecated
standalone indexer, not to the Stratos service.
