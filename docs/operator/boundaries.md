# Manage boundaries in Stratos

The **Boundaries** tab owns boundary definitions, room metadata, and enrollment
policy. Open the admin interface, select **Boundaries**, and create or manage a
boundary. The `/domains` admin link opens the same screen.

## Boundary fields

A boundary's name and public room ID are permanent. You can edit:

- display name and description
- room listing
- whether people may join
- automatic enrollment
- application access policy

A listed room appears in public discovery. Closing joins does not remove
existing members. An unlisted boundary can still hold members.

Creating a boundary grants no access to a feed generator, indexer, or other
service. Grant access separately.

## Open a boundary

Select a boundary to open its workspace. Each tab keeps the boundary selected,
so you can move between them without searching again.

### Overview

Overview shows the stored policy for the boundary. It does not show effective
access, live membership, or feed readiness. These are separate:

- A public room listing is not public content access.
- An application allow-list entry is not a membership.

### Members

Members lists the enrollments in this boundary, including inactive people and
service accounts. Members does not create enrollments; use **Enrollments** for
that.

Review one membership change at a time:

- The preview names the target DID and the selected boundary.
- Other boundary memberships stay unchanged.
- Stratos reads the current state before writing, but that read is not a
  compare-and-swap. A concurrent change can still land after it.
- Removing a membership is not a ban. An authorized join can be granted later.
- Adding an inactive enrollment does not activate it.

If a write result is uncertain, reconcile before retrying. Stratos reads the
member list, the enrollment, and the catalog again. Do not assume the first
write rolled back.

A local success does not guarantee immediate PDS publication. Pending
publication is reported separately.

The global **Enrollments** screen remains available for service-wide operations
and older filtered links.

### Settings

Settings shows every field of the current saved settings and the proposed
payload before you write.

- **Save changes** builds a review. **Confirm save** sends that reviewed payload
  at the revision shown.
- Editing a field after review cancels the review.
- A catalog refresh that brings a new revision also cancels the review.
- On a revision conflict, Stratos keeps your entered values and reloads the
  saved settings for a new review.
- If that reload fails, saving stays disabled until **Retry loading** succeeds.

## Unsaved settings

Stratos asks **Stay** or **Discard** before it leaves a page with unsaved
settings. This covers:

- switching tabs
- selecting another boundary
- opening catalog or global routes
- browser Back and Forward
- signing out

**Stay** keeps the draft and the review. **Discard** leaves the page without
saving the draft.

If a save is already in flight, the prompt says so, and that request can still
finish after you leave.

Forced session loss removes the admin interface immediately. Drafts are held in
memory only and are lost on reload or when the document closes.

## Deactivate and reactivate

The web interface cannot delete a boundary.

**Deactivate** does three things in order:

1. It stops new grants.
2. It removes every membership, including inactive users and service accounts.
3. It marks the boundary inactive.

The boundary name, room ID, records, and signed history remain stored.

While removals run, the card shows **Deactivating** and the remaining member
count. Stratos handles at most 100 members per pass and saves the unfinished
work, so a crash does not lose the deactivation. It also notifies each user's
PDS and the active sync clients whose access changed. Failed notifications are
retried and do not block other boundaries. The boundary becomes inactive only
after all removals and notifications finish.

The database rejects membership inserts or changes into deactivating and
inactive boundaries, including grants that race a deactivation on another
service process. Membership replacement and signed audit persistence share one
transaction, so a rejected grant cannot erase a member's other boundaries.

Settings lifecycle controls are separate from membership actions. Discard dirty
settings explicitly before you deactivate or reactivate. Deactivation does not
silently discard a draft.

**Reactivate** makes an empty inactive boundary available again. It does not
restore former members, replay configuration grants, or restore memberships
from a process-local cache. Add members again, or let people join if the room
permits it.

The reserved all-members boundary cannot be deactivated. It must always enroll
active members automatically.

Boundary changes use a revision check. When another admin has changed a
definition, reload its current state before your edit applies.

Active sync connections check enrollment and membership before each update.
Removing access or changing a boundary closes the connection, and the client
must reconnect with its current permissions. Newly granted access also requires
a new connection.

## Application access and credentials

An open application policy accepts any otherwise authorized client. An
allow-list requires at least one HTTPS client ID and verifies the client's
attestation before it issues a space credential. Client IDs cannot contain
embedded credentials or fragments.

New space credentials carry a signed `stratosBoundaryRevision`. Stratos
compares it with the active boundary definition on every request that
authenticates with a credential. Editing settings, deactivating, or reactivating
a boundary invalidates earlier local credentials. Legacy credentials without
that claim are accepted only while the imported boundary is still at revision 1.
Clients must refresh rejected credentials.

This local check does not make a foreign PDS introspect credentials. A PDS that
validates a previously issued multi-use credential offline may keep accepting it
until it expires. Deactivation stops the authority's membership-based ingestion
and local authorization. It cannot stop a person from writing to their own
repository or remove copies already downloaded.

## Move from file configuration

On the first startup with database-backed boundaries, Stratos copies the
configured boundaries, room details, automatic enrollment settings, and
per-space application rules into its database. The copy is all-or-nothing. If it
fails, Stratos retries without leaving half the settings imported.

The older `STRATOS_ALLOWED_DOMAINS`, `STRATOS_AUTO_ENROLL_DOMAINS`,
`STRATOS_ROOM_CATALOG_FILE`, and `STRATOS_SPACE_APP_ACCESS_FILE` /
`STRATOS_SPACE_APP_ACCESS` settings are used only for that first copy. Later
restarts keep changes made in the database, including inactive boundaries.

After you check the imported definitions in the admin tab, remove these legacy
boundary configuration entries, including environment references to retired
files. Keep the service DID and the reserved all-members boundary name stable.
The reserved boundary must remain present and active. If it becomes an unknown
or inactive definition, startup fails.

When automatic enrollment was previously unspecified or empty, the import keeps
the old default: automatically enroll members in the configured allowed
boundaries. Newly created boundaries default to no automatic enrollment. Review
this setting explicitly when you create a boundary.

Before startup completes, Stratos converts existing short boundary names to full
identifiers. It keeps other memberships and queues updates to users' enrollment
records.

Service-account configuration still defines service identities and keys. A new
account can initially receive only active boundaries that already exist. After
that, admins manage its membership in the database, and restarting does not
restore the original boundary list. Removing the identity from configuration
removes its service account when that configuration is applied.

Back up the service database together with the service identity and user data.
It holds the current boundary list, membership history, and any unfinished
boundary deactivations.

## Lexicon XRPC surface

All new admin requests use the existing HttpOnly admin session and CSRF checks.
They are checked-in lexicons, not private REST routes.

| Method                                  | Purpose                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `zone.stratos.admin.listBoundaries`     | Read definitions, lifecycle states, revisions, and member counts               |
| `zone.stratos.admin.createBoundary`     | Create an immutable name with editable settings                                |
| `zone.stratos.admin.updateBoundary`     | Replace settings at the expected revision                                      |
| `zone.stratos.admin.deactivateBoundary` | Start or resume durable membership removal and inactivation                    |
| `zone.stratos.admin.reactivateBoundary` | Reactivate an empty inactive boundary without restoring members                |
| `zone.stratos.server.listRooms`         | Public discovery of listed room metadata and join availability                 |
| `zone.stratos.sync.listBoundaries`      | Service-authenticated catalog of active boundaries the service currently holds |

Mutation responses return the current `boundary`; listing returns `boundaries`.
The service catalog includes room metadata, listing and joinability flags, and
the revision. It excludes administrative member counts and application
allow-lists. An inactive or ordinary user enrollment cannot use the service
catalog.

The feed generator uses an explicit feed registry, not the service catalog, to
map feed IDs to boundaries. Update that registry when you add or remove a feed,
then restart the feed generator and verify readiness. Grant its service identity
membership through Enrollments; a feed definition alone grants no access.
Room joinability is distinct from permission to read existing content. The
`zone.stratos.sync.listBoundaries` endpoint stays available to other service
consumers, but it is not the feed generator's feed-registry source.

## Remove a member or suspend one

Removing a membership permits a later authorized join. A durable suspension,
one that denies future grants until lifted, needs a separate restriction record
and checks on every grant path. Boundary administration does not implement that
feature. Keep a boundary's lifecycle separate from member suspension and from
service-wide enrollment activation.

## See also

- [Signed boundary history](./boundary-history)
