# Stratos Webapp

A simple demo SPA for interacting with the Stratos private namespace service. Built with Svelte 5 and Vite.

## Features

- **AT Protocol OAuth** — Sign in with any handle via `@atproto/oauth-client-browser`
- **Unified feed** — Reads public author posts and Stratos author posts via the deployed appview, then merges them client-side
- **Enrollment status** — Indicates whether the signed-in user is enrolled in Stratos, with an enrollment trigger button
- **Post creation** — Write public or private posts with a toggle; private posts are stored on Stratos with boundary restrictions

## Getting Started

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173, enter a handle, and sign in via OAuth.

### Run Locally Against Remote Services

The webapp includes a committed Vite mode for the configured Northsky root env profile:

```bash
pnpm install
pnpm dev:northsky
```

This starts the webapp locally on http://localhost:5173 while pointing it at the values in the root [../../.env.northsky](../../.env.northsky) profile:

- `VITE_STRATOS_URL`
- `VITE_APPVIEW_URL`
- `VITE_ATPROTO_HANDLE_RESOLVER`

Because the Vite env directory is the northsky root, override files should live there too, for example `.env.local` or `.env.northsky.local`.

If you are using the root Nx workspace, the equivalent command is:

```bash
npm run webapp:dev:northsky
```

This workflow depends on browser access to the remote Stratos and AppView origins. If requests fail in the browser, check CORS behavior on the remote services first.

## Project Structure

```
src/
├── App.svelte                 # Main shell (auth init, layout, state)
├── app.css                    # Base styles
├── main.ts                    # Entry point
└── lib/
    ├── auth.ts                # OAuth client wrapper
    ├── stratos.ts             # Enrollment discovery & enrollment trigger
    ├── stratos-agent.ts       # Agent routed to Stratos service URL
    ├── feed.ts                # Fetch & merge public + private posts
    ├── LoginScreen.svelte     # Handle input + sign in
    ├── EnrollmentIndicator.svelte  # Status badge + enroll button
    ├── Composer.svelte        # Post creation with private toggle
    ├── Feed.svelte            # Post list
    └── PostCard.svelte        # Single post card
```
