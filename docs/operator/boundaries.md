# Manage boundaries in Stratos

The admin **Boundaries** tab owns boundary definitions, room metadata and enrollment policy. Open the admin interface, select **Boundaries**, and create or manage a boundary. The existing `/domains` admin link opens the same screen.

A boundary's name and public room ID are permanent. You can edit its display name, description, room listing, whether people may join, automatic enrollment, and application access policy. A listed room appears in public discovery; closing joins does not remove existing members. An unlisted boundary can still hold members.

Use the member link to open the existing Enrollments view for that boundary. The same administration flow manages user and service-account memberships. Creating a boundary does not grant a feed generator, indexer, or other service access to it.

## Move from file configuration

On the first startup with this feature, Stratos imports the configured allowed boundaries into its SQLite or PostgreSQL service database. It also imports room IDs and metadata from the room catalog, automatic enrollment settings, and per-space application access policies. The import and its completion marker are one transaction; a failed import is retried without a partial catalog.

The relevant legacy settings are `STRATOS_ALLOWED_DOMAINS`, `STRATOS_AUTO_ENROLL_DOMAINS`, `STRATOS_ROOM_CATALOG_FILE`, and `STRATOS_SPACE_APP_ACCESS_FILE` / `STRATOS_SPACE_APP_ACCESS`. They seed the catalog once. Subsequent restarts preserve database edits and inactive boundaries instead of restoring those file values.

After checking the imported definitions in the admin tab, remove these legacy boundary configuration entries, including environment references to retired files. Keep the service DID and reserved all-members boundary name stable. The reserved boundary must remain present and active; changing it to an unknown or inactive definition prevents startup.

When automatic enrollment was previously unspecified or empty, the import preserves the old default of automatically enrolling members in the configured allowed boundaries. Newly created boundaries default to no automatic enrollment. Review this setting explicitly when creating a boundary.

Existing bare membership names are normalized to the authority-qualified name through the signed membership transaction layer before startup completes. The conversion preserves unrelated membership rows and queues enrollment-record synchronization.

Service-account configuration still declares service identities and keys. For a new service account, its initial boundary references must exist in the persistent catalog and only active boundaries are granted. After that first grant, the database owns its memberships; restarting does not overwrite admin changes with the old boundary list. Removing a service identity from its configuration retains the existing service-reconciliation behavior of pruning that account.

Back up the service database along with the service identity and actor data. It now contains the authoritative boundary catalog, membership audit, and unfinished deactivation work.

## Deactivate and reactivate

The web interface cannot delete a boundary. **Deactivate** first prevents new grants, then removes every membership, and finally marks the boundary inactive. This includes inactive users and service accounts. The boundary name, room ID, records, and signed history remain stored.

The UI shows **Deactivating** while removals are in progress. Each pass handles at most 100 members per boundary. A durable per-member work queue lets the service resume after a crash, including a crash between removing a membership and delivering its PDS/sync invalidation. A failed delivery remains pending and retries; one failing boundary does not stop other boundaries progressing. The service marks the boundary inactive only after both its memberships and pending work are empty.

The database rejects membership inserts or changes into deactivating and inactive boundaries. This includes grants racing a deactivation on another service process. Membership replacement and signed audit persistence share a transaction, so a rejected grant cannot partially erase the member's other boundaries.

**Reactivate** makes an empty inactive boundary available again. It does not restore its former members, replay configuration grants, or resurrect memberships from a process-local cache. An admin can add members again, or people can join if the room permits it. The reserved all-members boundary cannot be deactivated and must always automatically enroll active members.

Boundary changes use a revision check. When another admin has changed a definition, reload its current state before retrying your edit.

Established sync streams check current enrollment, memberships, and held boundary revisions before each emitted frame. Removing a grant or editing a held boundary closes the stream; consumers reconnect and authorize their new scope. A later grant never widens an already-open stream.

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

A feed generator consuming the service catalog can follow admin changes without a separate feed-definition file. Grant it membership explicitly through Enrollments. Catalog discovery never grants the consumer additional access; room joinability is distinct from permission to read existing content.

## Removing a member versus suspending one

Removing a membership permits a later authorized join. A durable suspension that denies future grants until lifted requires a separate restriction record and checks on every grant path. That feature is not implemented by boundary administration. Keep a boundary's lifecycle separate from member suspension and from service-wide enrollment activation.

See [signed boundary history](./boundary-history) for membership audit and replay contracts.
