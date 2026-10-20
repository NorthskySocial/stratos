# Admin boundary interface

The Boundaries tab uses the `zone.stratos.admin` catalog lexicons through the
existing admin session cookie. `/domains` remains a route alias. The interface
creates and edits boundary settings, links to members, deactivates with a clear
confirmation, polls membership removal, and reactivates empty boundaries. It has
no boundary deletion operation.

## Contextual workspace

Open Overview, Members or Settings for a selected boundary. Overview reports
configured policy, not effective access or feed readiness. Members includes
inactive enrollments and service accounts. Global Enrollments remains available
for service-wide administration and old filtered links.

Membership review previews one add/remove delta. It revalidates before writing,
but is advisory: membership APIs have no revision/CAS guarantee. Other boundaries
remain unchanged. Removal is not a ban, and adding an inactive enrollment does
not activate it. Unenrolled identities must use global enrollment tools.
Uncertain results require fresh reads before retry; no rollback is implied.
Local success and pending PDS publication are reported separately.

Settings review shows every before/after payload field and its expected revision.
The existing conversion trims the display name and clears client IDs for open
application access. Editing or a refreshed revision invalidates review. Confirm
sends that reviewed payload once; cancel sends no write. A stale revision reloads
the saved boundary while retaining raw form values. Saving stays disabled if
that reload fails; **Retry loading** recovers the current revision before review.
Reserved boundaries keep automatic enrollment enabled and cannot deactivate.

Unsaved settings require Stay or Discard for tabs, selected-boundary changes,
catalog/global links, browser history and explicit sign-out. Stay retains the
draft and review. Forced session loss removes privileged UI immediately.
Drafts are not stored across reloads or document closure.

Lifecycle controls are separate from membership actions. Discard dirty settings
explicitly before a lifecycle operation. Deactivation removes all memberships,
retains records/name/history, and polls progress. Reactivation starts empty.
Settings changes invalidate earlier local boundary credentials, not credentials
validated offline by foreign PDSs before their expiry.

## Local verification

Install workspace dependencies with `pnpm install --frozen-lockfile`. From this
directory:

```sh
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts
node ../../node_modules/@stryker-mutator/core/bin/stryker.js run --mutate 'src/lib/boundary-workspace.ts' --testFiles 'tests/boundary-workspace.test.ts' --dryRunOnly > /tmp/boundary-workspace-mutation-dry.log 2>&1
node ../../node_modules/@stryker-mutator/core/bin/stryker.js run --mutate 'src/lib/boundary-workspace.ts' --testFiles 'tests/boundary-workspace.test.ts' > /tmp/boundary-workspace-mutation.log 2>&1
```

Use direct Node here because nested pnpm exec fails in this manifest-less directory.
The scoped mutation command covers the workspace helper and selects its tests. Its in-place run is isolated to the
admin UI directory; do not edit these files while it is running. Component
workflows are exercised in Chromium by the browser smoke below.

From `stratos-service`, start the local admin Vite server:

```sh
pnpm exec vite --config admin-ui/vite.config.ts --host 127.0.0.1 --port 6174
```

Then, from this directory, run:

```sh
timeout 120 node tests/browser-smoke.mjs
```

The browser smoke uses the webapp's Playwright dependency and installed Chromium.
It intercepts every service request with local fixtures and blocks non-loopback
requests. It does not sign in or contact a running Stratos service. It checks
create/edit payloads, revision conflicts and failed reload recovery, reserved
boundaries, deactivation progress, empty reactivation, member navigation, errors,
and narrow-screen overflow. Screenshots are written under `/tmp/boundary-ui-*`.
`PLAYWRIGHT_MODULE` can point to an already installed local Playwright module
when only the service's workspace dependencies were installed.
