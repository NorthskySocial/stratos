# Stratos Webapp

A simple demo SPA for interacting with the Stratos private namespace service. Built with Svelte 5 and Vite.

## Features

- **AT Protocol OAuth** — Sign in with any handle via `@atproto/oauth-client-browser`
- **Unified feed** — Shows public (`app.bsky.feed.post`) and private (`zone.stratos.feed.post`) posts together, sorted by time
- **Enrollment status** — Indicates whether the signed-in user is enrolled in Stratos, with an enrollment trigger button
- **Post creation** — Write public or private posts with a toggle; private posts are stored on Stratos with boundary restrictions

## Getting Started

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173, enter a handle, and sign in via OAuth.

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
