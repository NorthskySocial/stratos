# Admin boundary interface

The Boundaries tab uses the `zone.stratos.admin` catalog lexicons through the
existing admin session cookie. `/domains` remains a route alias. The interface
creates and edits boundary settings, links to members, deactivates with a clear
confirmation, polls membership removal, and reactivates empty boundaries. It has
no boundary deletion operation.

A stale revision reloads the saved boundary while retaining the form values.
Saving stays disabled if that reload fails; **Retry loading** recovers the
current revision before the operator retries. Reserved boundaries keep automatic
enrollment enabled and have no deactivation control.

## Local verification

Install workspace dependencies with `pnpm install --frozen-lockfile`. From this
directory:

```sh
pnpm exec vitest run --config vitest.config.ts
pnpm exec stryker run
```

This Stryker config covers only the boundary form conversion, new XRPC client,
and changed shared request-wrapper region. Its in-place run is isolated to the
admin UI directory; do not edit these files while it is running. Component
workflows are exercised in Chromium by the browser smoke below.

From `stratos-service`, start the local admin Vite server:

```sh
pnpm exec vite --config admin-ui/vite.config.ts --host 127.0.0.1 --port 6174
```

Then, from this directory, run:

```sh
node tests/browser-smoke.mjs
```

The browser smoke uses the webapp's Playwright dependency and installed Chromium.
It intercepts every service request with local fixtures and blocks non-loopback
requests. It does not sign in or contact a running Stratos service. It checks
create/edit payloads, revision conflicts and failed reload recovery, reserved
boundaries, deactivation progress, empty reactivation, member navigation, errors,
and narrow-screen overflow. Screenshots are written under `/tmp/boundary-ui-*`.
`PLAYWRIGHT_MODULE` can point to an already installed local Playwright module
when only the service's workspace dependencies were installed.
