# Operations

## Health and readiness

The feed generator exposes `/health`. It reports the running version, service-stream connection state, and active actor sync count.

Treat a healthy HTTP process and a ready feed projection as separate states. A feed generator must complete its enrollment reconciliation before it serves a projection that depends on current authorization.

## Projection lifecycle

The feed generator keeps a service subscription for enrollment events and actor subscriptions for matching members. It stores cursor state with its projection. On startup and reconnect, it reconciles enrollments before it seeds active actor subscriptions.

When a user unenrolls or loses a configured boundary, remove the actor from the subscription pool, purge derived records for that boundary, and invalidate cached viewer membership.

## Backups and recovery

Back up the authoritative Stratos storage on its own schedule. The feed generator projection is derived state, but back up its storage when replay time or operational recovery matters.

Do not use a feed generator backup as the source of truth for private records. Recover authoritative records from Stratos repositories and CAR export procedures.
