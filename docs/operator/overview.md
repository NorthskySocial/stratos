# Operator Guide

Run Stratos when your application needs private records that keep AT Protocol identity and repository semantics.

## Services

| Service         | Responsibility                                                               | State         |
| --------------- | ---------------------------------------------------------------------------- | ------------- |
| Stratos service | Enrollment, private repositories, boundary checks, repository and sync XRPC. | Authoritative |
| Feed generator  | Local projection, fully hydrated feed views, feed blob delivery.             | Derived       |
| User PDS        | User OAuth authorization and the public enrollment record.                   | External      |

The feed generator is the supported projection path for private feeds. It is not a generic AppView. It serves only configured boundaries and must be treated as a privileged Stratos service identity.

## Before deployment

1. Provide a stable service URL and DID for Stratos.
2. Configure storage, OAuth, signing, and allowed boundaries.
3. Register feed generator identity, signing key, storage, and feed configuration.
4. Limit service-auth permissions to the required boundaries and lexicons.
5. Configure health, telemetry, backups, and alerts before serving users.

Read [Architecture](/operator/architecture) before choosing topology. Read [Telemetry](/operator/telemetry) before configuring production monitoring.
