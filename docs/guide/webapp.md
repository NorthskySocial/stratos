---
audience: Members and app developers
type: Guide
status: current
---

# Stratos WebApp (Demo Client)

The fastest way to understand Stratos is to use it once. The Stratos WebApp
is a small demo client that lets you do exactly that: sign in, join a Stratos service, post into a boundary, and watch the post
show up in a private feed.

It is a single-page application built with Svelte 5 and Vite. It is a
reference for client developers, not a product.

## What you can do with it

- **Sign in** with your AT Protocol handle, through OAuth.
- **Enroll** with a Stratos service and see your enrollment status and
  boundaries.
- **Write a private post** into one boundary, from the same composer you use
  for public posts.
- **Read one feed** that mixes your public posts with private posts from the
  boundaries you hold.
- **Inspect a record**: what is stored for a post, read from the place that
  holds it. See [The record inspector](#the-record-inspector).

## What it demonstrates

The webapp is worth reading because it handles both custody classes.

When you post privately, it looks at your enrollment's `custody`:

- `stratos` custody: it sends `com.atproto.repo.createRecord` to the Stratos
  service.
- `pds` custody: it sends `com.atproto.space.createRecord` to your own PDS,
  into the boundary's space.

Private feeds come from the feed generator. The webapp calls
`zone.stratos.feedgen.getFeed` through your PDS, with an `atproto-proxy`
header that names the feed generator. Attachments load the same way, through
`zone.stratos.feedgen.getBlob`.

### The record inspector

The inspector reads the address of the post and the account you are signed in
as. It then shows one of four states.

| The address is                                            | The inspector shows                                                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A Stratos-custody record (`at://` and three parts)        | Two panels: the public stub on the author's PDS, and the record Stratos holds                                     |
| A space record that you wrote (`at:space/` and six parts) | Your record on your PDS, read with your sign-in. An error answer names the error and has a retry button           |
| A space record that another member wrote                  | A panel titled "Feed snapshot". It is the copy the feed served, not a live read from the PDS. It sends no request |
| Not a record address                                      | An error, "This record address is not valid", and no request                                                      |

A feed snapshot is a copy. It can be stale, and the record can be gone from the
author's PDS. The panel says that it is a copy and not a live read.

## Architecture

The webapp is a standard Vite + Svelte project. It builds on these
libraries:

| Library                                   | Used for                                      |
| ----------------------------------------- | --------------------------------------------- |
| `@atproto/api`                            | Standard AT Protocol calls                    |
| `@atproto/oauth-client-browser`           | The OAuth flow and DPoP-bound sessions        |
| `@northskysocial/stratos-browser`         | Browser OAuth setup and service-routed agents |
| `@northskysocial/stratos-client`          | The OAuth scopes a Stratos app requests       |
| `@northskysocial/stratos-core` (`spaces`) | Mapping a boundary to its space URI           |

### Core modules

| Module                     | Role                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `src/lib/auth.ts`          | OAuth client setup and session restore                           |
| `src/lib/stratos.ts`       | Enrollment discovery, the enroll redirect, and the boundary list |
| `src/lib/stratos-agent.ts` | An agent that routes requests to the Stratos service             |
| `src/lib/feed.ts`          | Fetches public and private posts and merges them into one feed   |
| `src/lib/Composer.svelte`  | The composer, including the custody-aware private write          |
| `src/lib/post-deletion.ts` | Custody-aware delete                                             |
| `src/lib/inspector.ts`     | Chooses where the inspector reads a post from                    |

## Local development

```bash
cd webapp
pnpm install
pnpm dev
```

The webapp is then available at `http://localhost:5173`.

### Connecting to remote services

The webapp reads its endpoints from `VITE_*` environment variables, such as
`VITE_STRATOS_URL`, `VITE_STRATOS_SERVICE_DID`, `VITE_FEEDGEN_DID`, and
`VITE_APPVIEW_URL`.

To point a local webapp at a deployed Stratos service, use the `northsky`
mode:

```bash
pnpm dev:northsky
```

Vite loads the matching `.env.northsky` file. The webapp looks for env files
two directories above `webapp/`, which is the directory that contains the
`stratos` checkout.

## Deployment

The webapp builds to a static site. The repository includes a `Dockerfile`
that builds it and serves it with Nginx.
