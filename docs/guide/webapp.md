# Stratos WebApp (Demo Client)

The Stratos WebApp is a simple, single-page application (SPA) that demonstrates how to interact with the Stratos private namespace service. It is built with Svelte 5 and Vite.

## Purpose

The WebApp serves several roles in the Stratos ecosystem:
1. **Reference Implementation**: Shows how to use `@atproto/oauth-client-browser` with Stratos.
2. **User Interface**: Provides a way for users to enroll in a Stratos service and manage their private posts.
3. **Developer Demo**: Demonstrates how to fetch and merge public and private feeds client-side.

## Key Features

- **AT Protocol OAuth**: Sign in using your ATProtocol handle.
- **Enrollment Management**: Check your enrollment status and trigger enrollment with a Stratos service.
- **Unified Feed**: Displays a combined view of your public posts (from your PDS) and private posts (from Stratos).
- **Private Posting**: Create posts with boundary-based access control directly from the composer.
- **Record Inspector**: View the raw CID and metadata for both public and private records.

## Architecture

The WebApp is structured as a standard Vite-based Svelte project. It uses the following libraries:
- `atproto-api`: For interacting with standard ATProtocol endpoints.
- `@atproto/oauth-client-browser`: For managing the OAuth flow.
- `@northskysocial/stratos-client`: For Stratos-specific discovery, routing, and record verification.

### Core Modules

- `src/lib/auth.ts`: A wrapper around the ATProtocol OAuth client.
- `src/lib/stratos-agent.ts`: An agent that routes requests to the correct Stratos service based on the user's enrollment.
- `src/lib/feed.ts`: Logic for fetching posts from both the AppView (public) and Stratos (private) and merging them.

## Local Development

To run the WebApp locally for development:

```bash
cd webapp
pnpm install
pnpm dev
```

The WebApp will be available at `http://localhost:5173`.

### Connecting to Remote Services

You can point the local WebApp at remote Stratos and AppView instances using environment variables:

```bash
pnpm dev:northsky
```

This uses the `northsky` profile which pulls configuration from a root `.env.northsky` file.

## Deployment

The WebApp can be deployed as a static site. The repository includes a `Dockerfile` that builds the app and serves it via Nginx, which is suitable for containerized environments like Docker or Kubernetes.
