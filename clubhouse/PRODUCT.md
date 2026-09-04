# Clubhouse

Clubhouse is a public-alpha browser client for discovering and joining
Stratos-backed rooms, then reading and contributing to each room's private
conversation.

## People and jobs

- ATProto users sign in with a handle, with typeahead available as a convenience.
- Visitors scan a public room catalogue and understand whether each room is joined,
  open, pending, or unavailable.
- Members open a room, read its feed, start topics, reply, and delete posts they own.

## Product truths

- Room state shown in the browser is informative; Stratos remains the authorization
  authority.
- Boundary identifiers never belong in browser routes, catalogue data, or UI state.
- Public actor profile data may enrich handles with display names and avatars, but
  the feed remains usable when profile hydration is unavailable.
- Posts may be held by a PDS or by Stratos. The integration selects the correct
  writer and deletion path without exposing that storage distinction as a user task.
- Clubhouse is an alpha demonstration. Its copy does not promise confidentiality,
  complete threads, or availability beyond what the backing services establish.

## Experience promise

Clubhouse should feel like entering a lively community publication: clear enough to
use immediately, expressive enough that every room has its own identity, and honest
about unavailable or pending states.
