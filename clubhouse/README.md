# Clubhouse public-alpha shell

Clubhouse is a separately deployable Svelte 5 + Tailwind 4 browser shell for
the Plan 024 public-alpha rooms. It currently displays the public response from
`GET /oauth/boundaries`, renders room and enrollment placeholder states, and keeps
the room URL durable as `/rooms/:id`.

Clubhouse restores browser OAuth through `@northskysocial/stratos-browser`,
reads `GET /oauth/boundaries`, and fetches the existing Feedgen `getFeed` XRPC
through the signed-in user's PDS proxy. It does not make an access decision:
room state comes from Stratos's boundary-free status endpoint, and writes use
the server-approved Stratos writer or a deployment-owned authority-space URI
for PDS custody.

Pass `integration` to `App.svelte` to replace those production seams in an
embedding application:

```ts
const integration = {
  getRoomState: (roomId: string) => 'unjoined' as const,
  requestJoin: async (roomId: string) => {
    // Hand roomId to the host application's enrollment callback.
    return 'pending' as const
  },
}
```

The callback receives only a public room/feed ID. Boundaries are not part of
the browser types, URL, or UI state. UI state is informative and never an
authorization decision. Copy describes rooms as open membership areas and
does not promise confidentiality or complete threads.

## Local development

From this directory:

```sh
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

The package is in the pnpm workspace but can be deployed independently. Its
default catalogue, room-status, and Stratos-custody post URLs are derived from
`VITE_STRATOS_URL`; no same-origin reverse proxy is required. Configure:

- `VITE_STRATOS_URL` and `VITE_STRATOS_SERVICE_DID`
- `VITE_FEEDGEN_URL` and `VITE_FEEDGEN_DID`
- `VITE_CLUBHOUSE_URL` (the public browser origin)
- optionally `VITE_CLUBHOUSE_ROOM_STATUS_URL` to override the default
  DPoP-authenticated `{ rooms: [{ id, state }] }` endpoint. Its response has no
  boundaries.
- optionally `VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON` (a deployment-owned map from
  room IDs to authority-space URIs). The PDS is still the authority for these
  writes. Stratos-custody posts go only to `POST /oauth/boundaries/post`, which
  resolves the canonical boundary and verifies membership server-side.

## Production container

The production image builds the browser bundle and serves it with Nginx. Its
public `VITE_*` configuration is intentionally supplied as Compose build args:
Vite embeds those values in the browser bundle, so changing them requires an
image rebuild.

From this directory, place the required settings in `.env` and start it:

```sh
VITE_STRATOS_URL=https://stratos.example.com
VITE_STRATOS_SERVICE_DID=did:web:stratos.example.com
VITE_FEEDGEN_URL=https://feedgen.example.com
VITE_FEEDGEN_DID=did:web:feedgen.example.com
VITE_CLUBHOUSE_URL=https://clubhouse.example.com
CLUBHOUSE_PORT=8080

docker compose up --build -d
```

The image emits `/client-metadata.json` using those same values for OAuth
discovery. `VITE_CLUBHOUSE_URL` must therefore be the final public HTTPS origin,
not an internal Docker hostname. Optional settings are
`VITE_CLUBHOUSE_ROOM_STATUS_URL`, `VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON`,
`VITE_ATPROTO_HANDLE_RESOLVER`, and `VITE_ATPROTO_OAUTH_PROXY_URL`.

## Icon attribution

The three local interface icons in `src/lib/icons/` are copied from the
[IconaMoon 1.1](https://github.com/dariushhpg1/IconaMoon) Light set by
Dariush.
