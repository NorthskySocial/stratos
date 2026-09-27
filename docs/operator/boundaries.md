# Manage boundaries in Stratos

The admin **Boundaries** tab owns boundary definitions, room metadata and enrollment policy. Open the admin interface, select **Boundaries**, and create or manage a boundary. The existing `/domains` admin link opens the same screen.

A boundary's name and public room ID are permanent. You can edit its display name, description, room listing, whether people may join, automatic enrollment, and application access policy. A listed room appears in public discovery; closing joins does not remove existing members. An unlisted boundary can still hold members.

Use the member link to open the existing Enrollments view for that boundary. The same administration flow manages user and service-account memberships. Creating a boundary does not grant a feed generator, indexer, or other service access to it.

## Move from file configuration

On the first startup with database-backed boundaries, Stratos copies the
configured boundaries, room details, automatic enrollment settings, and
per-space application rules into its database. The copy is all-or-nothing: if
it fails, Stratos retries without leaving half the settings imported.

The older `STRATOS_ALLOWED_DOMAINS`, `STRATOS_AUTO_ENROLL_DOMAINS`,
`STRATOS_ROOM_CATALOG_FILE`, and `STRATOS_SPACE_APP_ACCESS_FILE` /
`STRATOS_SPACE_APP_ACCESS` settings are used only for that first copy. Later
restarts keep changes made in the database, including inactive boundaries.

After checking the imported definitions in the admin tab, remove these legacy boundary configuration entries, including environment references to retired files. Keep the service DID and reserved all-members boundary name stable. The reserved boundary must remain present and active; changing it to an unknown or inactive definition prevents startup.

When automatic enrollment was previously unspecified or empty, the import preserves the old default of automatically enrolling members in the configured allowed boundaries. Newly created boundaries default to no automatic enrollment. Review this setting explicitly when creating a boundary.

Before startup completes, Stratos converts existing short boundary names to
full identifiers. It keeps other memberships and queues updates to users'
enrollment records.

Service-account configuration still defines service identities and keys. A
new account can initially receive only active boundaries that already exist.
After that, admins manage its membership in the database; restarting does not
restore the original boundary list. Removing the identity from configuration
removes its service account when that configuration is applied.

Back up the service database along with the service identity and user data.
It holds the current boundary list, membership history, and any unfinished
boundary deactivations.

## Deactivate and reactivate

The web interface cannot delete a boundary. **Deactivate** first prevents new grants, then removes every membership, and finally marks the boundary inactive. This includes inactive users and service accounts. The boundary name, room ID, records, and signed history remain stored.

The UI shows **Deactivating** while removals are in progress. Stratos handles
at most 100 members per pass and saves the remaining work so it can resume
after a crash. This includes notifying users' PDSs and active sync clients
that access changed. Failed notifications are retried and do not stop other
boundaries. The boundary becomes inactive only when all members have been
removed and all notifications have finished.

The database rejects membership inserts or changes into deactivating and inactive boundaries. This includes grants racing a deactivation on another service process. Membership replacement and signed audit persistence share a transaction, so a rejected grant cannot partially erase the member's other boundaries.

**Reactivate** makes an empty inactive boundary available again. It does not restore its former members, replay configuration grants, or resurrect memberships from a process-local cache. An admin can add members again, or people can join if the room permits it. The reserved all-members boundary cannot be deactivated and must always automatically enroll active members.

Boundary changes use a revision check. When another admin has changed a definition, reload its current state before retrying your edit.

Active sync connections check enrollment and membership before each update.
Removing access or changing a boundary closes the connection; the client must
reconnect with its current permissions. Newly granted access also requires a
new connection.

## Application access and credentials

An open application policy accepts any otherwise authorized client. An allow-list requires at least one HTTPS client ID and verifies the client's attestation before issuing a space credential. Client IDs cannot contain embedded credentials or fragments.

New space credentials carry a signed `stratosBoundaryRevision`. Stratos compares it to the active boundary definition on every credential-authenticated request. Editing settings, deactivating, or reactivating a boundary invalidates earlier local credentials. Legacy credentials without that claim are accepted only while the imported boundary is still at revision 1. Clients must refresh rejected credentials.

This local check does not make a foreign PDS introspect credentials. A PDS that validates a previously issued multi-use credential offline may continue accepting it until expiry. Deactivation stops the authority's membership-based ingestion and local authorization; it cannot prevent a person from writing to their own repository or remove copies already downloaded.

## Lexicon XRPC surface

All new admin requests use the existing HttpOnly admin session and CSRF checks. They are checked-in lexicons, not private REST routes.

| Method                                  | Purpose                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `zone.stratos.admin.listBoundaries`     | Read definitions, lifecycle states, revisions, and member counts               |
| `zone.stratos.admin.createBoundary`     | Create an immutable name with editable settings                                |
| `zone.stratos.admin.updateBoundary`     | Replace settings at the expected revision                                      |
| `zone.stratos.admin.deactivateBoundary` | Start or resume durable membership removal and inactivation                    |
| `zone.stratos.admin.reactivateBoundary` | Reactivate an empty inactive boundary without restoring members                |
| `zone.stratos.server.listRooms`         | Public discovery of listed room metadata and join availability                 |
| `zone.stratos.sync.listBoundaries`      | Service-authenticated catalog of active boundaries the service currently holds |

Mutation responses return the current `boundary`; listing returns `boundaries`. The service catalog includes room metadata, listing/joinability flags, and revision, but excludes administrative member counts and application allow-lists. An inactive or ordinary user enrollment cannot use the service catalog.

The feed generator uses an explicit feed registry rather than the service catalogue to
map feed IDs to boundaries. Update that registry when adding or removing a
feed, then restart the feed generator and verify readiness. Grant its service identity
membership through Enrollments; a feed definition alone grants no access.
Room joinability is distinct from permission to read existing content. The
`zone.stratos.sync.listBoundaries` endpoint remains available to other service
consumers but is not the feed generator's feed-registry source.

## Removing a member versus suspending one

Removing a membership permits a later authorized join. A durable suspension that denies future grants until lifted requires a separate restriction record and checks on every grant path. That feature is not implemented by boundary administration. Keep a boundary's lifecycle separate from member suspension and from service-wide enrollment activation.

See [signed boundary history](./boundary-history) for membership audit and replay contracts.
