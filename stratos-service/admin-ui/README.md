# Admin boundary interface

The Boundaries tab reads and writes the `zone.stratos.admin` catalog lexicons
through the existing admin session cookie. `/domains` is a route alias for the
same screen.

The interface creates and edits boundary settings, opens the member workspace,
deactivates with a confirmation, polls membership removal, and reactivates empty
boundaries. It cannot delete a boundary.

## Components

| File                                                  | Owns                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/App.svelte`                                      | Accepted and attempted location, history stamping, the navigation guard, sign-out      |
| `src/routes/Boundaries.svelte`                        | Catalog load and polling, boundary selection, create draft, membership operation state |
| `src/lib/components/boundary/BoundaryOverview.svelte` | Read-only policy view                                                                  |
| `src/lib/components/boundary/BoundaryMembers.svelte`  | Member list, lookup, one-change membership review                                      |
| `src/lib/components/boundary/BoundarySettings.svelte` | Settings draft, review, revision recovery, lifecycle actions                           |
| `src/lib/boundary-workspace.ts`                       | Pure route, membership, and settings helpers used by the components                    |

Components register a `BoundaryNavigationGuard` through the
`BOUNDARY_NAVIGATION` context. The guard reports whether a draft is dirty and
how to discard it. `App.svelte` decides navigation and shows the Stay/Discard
prompt.

## Behaviour to preserve

### Overview

Overview renders stored boundary policy only. It must not imply effective
access, live membership, or feed readiness. It keeps the last loaded boundary
visible while a background refresh runs.

### Members

- The workspace reviews one add or remove change at a time, and never replaces
  the member set.
- The preview names the target DID and boundary. Confirmation re-reads the
  enrollment, the boundary, and the catalog before the write.
- Membership APIs offer no compare-and-swap. The re-read is a freshness check,
  not a guarantee, so a concurrent change can still land after it.
- A failed or dropped write is uncertain, not rolled back. The operator must
  reconcile before another reviewed attempt. Reconciliation requires the member
  list, the enrollment, and the catalog to read successfully.
- Pending and uncertain state is scoped to the authenticated identity and
  survives leaving and re-entering the route.
- Removal is not a ban. Adding an inactive enrollment does not activate it.
  Unenrolled identities are not created here.

### Settings

- The review shows every before/after payload field and the expected revision.
  `boundarySettings` trims the display name and clears client IDs for open
  application access.
- Editing a field, or a refresh that changes the revision, invalidates the
  review. Confirm sends the reviewed payload once; cancel sends no write.
- A stale revision keeps the entered draft and reloads the saved boundary. If
  that reload fails, saving stays disabled until **Retry loading** succeeds.
- Dirty settings block lifecycle actions until the operator discards them
  explicitly.
- Restricted fields: reserved boundaries keep automatic enrollment enabled and
  cannot be deactivated. Deactivation removes all memberships, retains records,
  name, and history, and polls progress. Reactivation starts empty.

### Navigation guard

- Stay keeps the draft and the review. Discard leaves without saving.
- An in-flight save is not a draft. The guard reports it through `pending`, and
  the prompt states that the request may still complete.
- The prompt covers tabs, selected-boundary changes, catalog and global routes,
  browser Back and Forward, and explicit sign-out.
- Forced session loss removes privileged UI immediately.
- Drafts are in memory only. A reload or a closed document drops them.

## Local verification

Install workspace dependencies with `pnpm install --frozen-lockfile`. Run the
unit tests from this directory:

```sh
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts
```

Run direct Node rather than `pnpm exec` here. This directory has no manifest, so
nested `pnpm exec` fails.

Mutate the workspace helper:

```sh
node ../../node_modules/@stryker-mutator/core/bin/stryker.js run \
  --mutate 'src/lib/boundary-workspace.ts' \
  --testFiles 'tests/boundary-workspace.test.ts' > /tmp/boundary-workspace-mutation.log 2>&1
```

Add `--dryRunOnly` for a quick smoke run. Stryker rewrites sources in place, so
do not edit these files while it runs.

### Browser smoke

From `stratos-service`, start the local admin Vite server:

```sh
pnpm exec vite --config admin-ui/vite.config.ts --host 127.0.0.1 --port 6174
```

Then, from this directory, run:

```sh
timeout 120 node tests/browser-smoke.mjs
```

The smoke test uses the webapp's Playwright dependency and installed Chromium.
It intercepts every service request with local fixtures and blocks non-loopback
requests, so it needs no account or running Stratos service. It covers:

- create and edit payloads
- revision conflicts and failed reload recovery
- reserved boundaries
- deactivation progress and empty reactivation
- member navigation and membership review races
- errors and narrow-screen overflow

Screenshots are written under `/tmp/boundary-ui-*`. `PLAYWRIGHT_MODULE` can
point to an installed local Playwright module when only the service workspace
dependencies are present.
