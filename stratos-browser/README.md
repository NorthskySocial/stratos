# Stratos browser helpers

`@northskysocial/stratos-browser` is the shared browser-only OAuth and
DPoP-aware service client for Stratos applications. It keeps browser protocol
setup in one package so product surfaces do not create competing OAuth flows.

```ts
import {
  createBrowserAuth,
  createServiceAgent,
} from '@northskysocial/stratos-browser'
```

`createServiceAgent` always registers the bundled Stratos lexicons. Pass
additional lexicons only when an application needs them; they are added without
replacing the Stratos definitions.

This package is intended for browser bundles. Server-side callers should use
the service's existing OAuth and request-verification paths.
