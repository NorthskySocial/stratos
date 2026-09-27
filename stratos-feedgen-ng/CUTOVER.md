# Feed generator rehearsal runbook

Use this only in an operator-approved disposable environment. It prepares a
reversible routing rehearsal; it does not authorize production traffic,
identity changes, or use of a shared projection database.

## Preconditions

- The TypeScript and Rust services use the same public feed DID, signing
  identity, public URL, configured feeds, and upstream authority identity.
- The feed DID is under the Stratos-controlled space domain and already has
  service membership in every boundary it serves. DNS, HTTPS, and routing for
  its `did:web` host are configured before either service starts.
- Each runtime has its own state directory and writer lock. Never mount the
  TypeScript database into the Rust feed generator or let both runtimes open
  one state directory.
- The Rust state volume is encrypted, writable only by the runtime identity,
  and its storage/signing-key files are private non-symlinks. Backups exclude
  the projection unless separately approved.
- A disposable test viewer, boundary, and short-lived service-auth header are
  available. Store the header in a mode-0600 file outside source control.
- The Rust container is limited to one CPU and 512 MiB. Confirm limits from
  inside its cgroup; host memory or Docker configuration alone is insufficient.

## Offline gate

Run these from the repository root before opening either route:

```sh
set -eu
pnpm exec tsx test/feedgen-harness/cli.ts privacy --implementation rust
pnpm exec tsx test/feedgen-harness/cli.ts recovery --implementation rust
FEEDGEN_PID=$(docker inspect -f '{{.State.Pid}}' stratos-feedgen-ng)
case $FEEDGEN_PID in '' | *[!0-9]* | 0) exit 1 ;; esac
test "$(basename "$(readlink -f /proc/$FEEDGEN_PID/exe)")" = stratos-feedgen-ng
FEEDGEN_CGROUP=$(awk -F: '$1 == "0" { print $3 }' /proc/$FEEDGEN_PID/cgroup)
test -n "$FEEDGEN_CGROUP"
pnpm exec tsx test/feedgen-harness/cli.ts limits \
  --cgroup-root "/sys/fs/cgroup$FEEDGEN_CGROUP"
```

The privacy and recovery commands are unit-level evidence only. A failed or
unavailable cgroup check stops the rehearsal; do not substitute an inferred
limit. Confirm `stratos-feedgen-ng` is the container name and that its PID is
the Rust process before collecting this evidence.

## Independent-state startup

1. Start the TypeScript service with its existing private state and verify a
   current authorized feed request.
2. Start the Rust feed generator with an empty encrypted state directory and
   its own writer lock. Wait for a successful authority reconciliation and an
   authorized feed request; `/health` alone is not readiness evidence.
3. Compare both services without retaining request data:

```sh
pnpm exec tsx test/feedgen-harness/cli.ts compare \
  --ts-url http://127.0.0.1:3000 \
  --rust-url http://127.0.0.1:3001 \
  --authorization-file /secure/path/feedgen-auth \
  --feed approved-feed-id
```

The comparator is loopback-only by default. Passing `--allow-remote` is an
explicit acknowledgement that the target is an approved private environment.
Its report contains only statuses and a bounded mismatch category.

## Switch and rollback

1. Quiesce and drain the TypeScript route. Do not stop its state volume or
   overwrite its cursor.
2. Re-run an authenticated Rust feed probe immediately before routing to it.
3. Atomically route the public endpoint to the Rust feed generator while
   preserving the DID, service fragment, audience, and signing identity.
4. Inject or observe a boundary removal or deletion. A response prepared before
   local invalidation must not be released; a removed post must not reappear.
5. To roll back, restore routing to TypeScript only after it has reconciled the
   current authority state and passes a fresh authenticated feed probe. Do not
   re-use the Rust projection as TypeScript state.

## Stop conditions and evidence

Stop immediately for an authorization mismatch, private data in telemetry or
reports, a missing/private-key failure, an unavailable resource limit, OOM,
readiness regression, stale deletion, or any uncertain rollback state.

Record only aggregate outcomes, deployment revisions, cgroup measurements,
error counts, and elapsed timings. Do not record service-auth headers, post
content, DIDs, URIs, boundaries, query strings, or raw response bodies.

This runbook does not replace the required controlled benchmark, PDS interop,
or Clubhouse browser validation. Mark those gates unrun until measured in the
approved disposable environment.
