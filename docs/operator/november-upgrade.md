---
audience: Operators
type: Upgrade procedure
prerequisites: A running Stratos service and the Rust feed generator, both on an October-contract build
status: current
---

# November upgrade and rollback

This page is for an operator who upgrades a Stratos service and a Rust feed
generator to the November spaces contract. It says what changes, what to copy
first, in what order to act, how to tell that each step worked, and how to go
back.

::: warning Members who host their own repo
Read this before you decide to upgrade a deployment that has members with
`pds` custody. The upgrade deletes their posts from the feed generator. The
feed generator reads them again only from a host that accepts the `at:space/`
spelling. The upstream reference PDS at the pinned revision and the spaces PDS
images that the sandbox pins do not accept it. Until a member's host accepts
it, that member's posts are gone from the feeds, their sync fails in every
pass, and they cannot post through Clubhouse or the webapp. See
[What cannot work yet](#what-cannot-work-yet).
:::

Each action has a mark.

- **READY**: you can do it now with what this page gives you.
- **PENDING AUTHORIZATION**: it needs a decision or a write that is not yours
  alone. Do not do it until the owner of the decision says so.
- **BLOCKED**: it cannot work until an outside condition is met. The page names
  the condition.

No part of this procedure has run against a real spaces PDS, a kept production
database or an older binary. [What was rehearsed](#what-was-rehearsed) says
what did run.

## What this upgrade changes

1. A space URI is `at:space/{authority}/{type}/{skey}`. A space record URI adds
   `/{author}/{collection}/{rkey}`. A Stratos-custody record keeps its `at://`
   address. Nothing accepts or converts a URI in any other form.
2. A credential bound to an HTTP-signature key is presented as
   `Authorization: Atproto-Space-Credential <jwt>` with an
   `Atproto-Space-Audience` header and a signature tagged
   `atproto-space-credential`. There is no dual acceptance.
3. A delegation and a client attestation name the audience
   `<authority did>#atproto_pds`.
4. The feed generator keeps a verified state for each member who hosts their own
   repo. It promotes a change only when the set hash equals the commit's
   `data`. Nothing is staged.
5. The feed generator's database moves to schema version 11. An older binary
   refuses the migrated file.
6. Migration 10 deletes the feed generator's posts and interactions of members
   with `pds` custody. They come back only through a verified whole-repo read
   from a host that accepts the `at:space/` spelling. The migration also
   resets the label cursor. Feeds stay closed until the label log has been
   read again.
7. A new setting, `FEEDGEN_SPACE_WRITE_RESERVE_BYTES`, keeps space writes from
   starving. The four `FEEDGEN_STAGE_*` settings are no longer read.
8. The pass output has new members. The reason words changed. Five old words
   are no longer reasons of a failed member, and one metric label value no
   longer exists.
9. The space type declaration in the repository says `title`. A spaces PDS
   older than the November release refuses a declaration without `name`.
10. Clubhouse reads room spaces in the new spelling. A room with a value in
    another form shows an error to members whose records are on their own PDS.

## Order

Do the steps in this order. Steps 4 to 10 are one window, in which the service
and the feed generator are down. Keep it short.

| Step | Action                                                                            | Mark                                                  |
| ---- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1    | [Record the running builds and settings](#step-1)                                 | READY                                                 |
| 2    | [List the members with `pds` custody](#step-2)                                    | READY                                                 |
| 3    | [Change alerts and dashboards that use removed words](#step-3)                    | READY                                                 |
| 4    | [Stop the feed generator, then the service](#step-4)                              | READY                                                 |
| 5    | [Copy the feed generator's database and note its schema version](#step-5)         | READY                                                 |
| 6    | [Copy the service's stores](#step-6)                                              | READY                                                 |
| 7    | [Delete earlier-spelling rows in the service's stores](#step-7)                   | READY in staging. PENDING AUTHORIZATION anywhere else |
| 8    | [Change the feed generator's settings](#step-8)                                   | READY                                                 |
| 9    | [Deploy the new service build and the new feed generator build together](#step-9) | READY                                                 |
| 10   | [Start the service, then the feed generator](#step-10)                            | READY                                                 |
| 11   | [Rebuild and deploy Clubhouse and the webapp](#step-11)                           | READY                                                 |
| 12   | [Publish the space type declaration](#the-space-type-declaration)                 | PENDING AUTHORIZATION                                 |
| 13   | [Check the upgrade](#after-the-upgrade)                                           | READY                                                 |

Step 12 does not have to be in this window. Nothing in the service, the feed
generator, Clubhouse or the webapp reads the declaration. A member's PDS reads
it when the member enrolls.

A mixed pair refuses each other. A feed generator sends the space of a mint
request to `zone.stratos.space.getSpaceCredential` in the spelling of its own
build. A service of the other build cannot parse it. It answers `UnknownSpace`
before it checks the delegation's audience. This is read from the code of both
builds. It was not run as a mixed pair.

- **New feed generator, old service.** The old service does not parse an
  `at:space/` URI. A PDS member's sync then fails with the reason `credential`.
- **Old feed generator, new service.** The new service parses only the
  `at:space/` form. A credential that the old feed generator already holds is
  presented in the earlier scheme, which the new service does not recognise.

The members whose records Stratos hosts are not touched by the audience change.
Their streams use service-auth tokens that name the Stratos DID.

A delegation or a client attestation made before the upgrade carries the old
audience and is refused after it. Delegations from the feed generator live 60
seconds, and each is used once. An app that caches an attestation must drop it
and make a new one for `<service did>#atproto_pds`.

A credential minted before the upgrade keeps its shape until it expires. One
bound to an HTTP-signature key works only when it is presented in the new
scheme. A credential bound to an HTTP-signature key lives 600 seconds by
default (`STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS`, at most 3,600). A
credential bound to a DPoP key lives 7,200 seconds by default
(`STRATOS_SPACE_CREDENTIAL_TTL_SECONDS`). The feed generator holds its
credentials in memory and mints again after a restart. Nothing needs to be
cleared.

## Before the window

Read [Sync behaviours to know](#sync-behaviours-to-know) and
[What cannot work yet](#what-cannot-work-yet) before step 4. Both describe what
the new feed generator does to posts once it runs.

### 1. Record the running builds and settings {#step-1}

The service and the feed generator report a `version` on `/health`. In the
commands, `<stratos origin>` is the service's public URL
(`STRATOS_PUBLIC_URL`) and `<feed generator origin>` is the feed generator's
(`FEEDGEN_PUBLIC_URL`). Each is the scheme, the host and any port, for example
`https://stratos.example.com`.

```sh
curl -s "<stratos origin>/health"
curl -s "<feed generator origin>/health"
```

An image built from the repository `Dockerfile` reports `0.3.2` for the service
before and after this upgrade. The feed generator reports `0.1.0` before and
after. The `version` does not tell the two builds apart. Record the image tag
and digest or the commit of each build as well: the service, the feed
generator, Clubhouse and the webapp. Record the value of
`VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON` that the running Clubhouse was built with.
You need all of them to pair the builds again on a rollback.

You know it worked when you hold, for each of the four, an identifier that
names exactly one build, and the Clubhouse value.

### 2. List the members with `pds` custody {#step-2}

In the admin interface, open **Boundaries**, select a boundary, open
**Members**, and set **Custody** to **PDS**. The same list is the admin query
`zone.stratos.admin.listEnrollments` with `custody=pds`. Each entry has a
`repoHost`. It is the host's origin with its scheme, for example
`https://pds.example.com`.

Ask each host for its release:

```sh
curl -s "<repoHost>/xrpc/_health"
```

The reference PDS answers this route with `{"version": ...}` (`basic-routes.ts`
at the pinned reference revision). A host may not report a build the way the
reference does. Record what it reports.

You know it worked when you have, for each member with `pds` custody, the host
and what it reports. These members lose their feed posts at step 10. See the
warning at the top of this page. The list also tells you how many members each
form of [the space type declaration](#the-space-type-declaration) affects.

### 3. Change alerts and dashboards {#step-3}

The reason words `host`, `target`, `stage`, `page_limit` and `operation_limit`
are no longer reasons of a failed member. `page_limit` remains a `kind` of the
`pds_space_membership_failed` line, for a membership listing that ran out of
pages. The value `member_rejected` of the `outcome` label of
`stratos.feedgen.space_sync.outcomes` no longer exists. An alert or a dashboard
keyed on a removed word or value never fires. [Monitoring](#monitoring) lists
the words and labels that exist now.

You know it worked when no alert or dashboard query uses a removed word as a
reason of `pds_space_target_failed` or `pds_space_target_failures`, or the
value `member_rejected`.

## The window

### 4. Stop the feed generator, then the service {#step-4}

The feed generator reads from the service, so stop it first and start it last.

Stop the feed generator with `SIGTERM` or `SIGINT`, so that it exits cleanly. A
clean exit removes its writer lock, a directory at `FEEDGEN_WRITER_LOCK_PATH`.
When that setting is not set, the lock is the database path followed by
`.writer-lock`.

In this command and the ones below, `$FEEDGEN_SQLITE_PATH`,
`$FEEDGEN_WRITER_LOCK_PATH` and `$STRATOS_DATA_DIR` stand for the values in the
feed generator's and the service's environment. Set them in your shell first,
or write the values in their place. `/backup` stands for a protected place of
your choice.

```sh
test -e "${FEEDGEN_WRITER_LOCK_PATH:-$FEEDGEN_SQLITE_PATH.writer-lock}" || echo released
```

Then stop the service.

You know it worked when the lock command prints `released`, and
`curl -s -o /dev/null -w '%{http_code}\n' "<stratos origin>/health"` no longer
answers `200`. A killed feed generator leaves its lock behind. Confirm that no
process uses the database, then remove the lock by hand.

### 5. Copy the feed generator's database {#step-5}

```sh
cp -p "$FEEDGEN_SQLITE_PATH" /backup/feedgen-before-november.sqlite
sha256sum "$FEEDGEN_SQLITE_PATH" /backup/feedgen-before-november.sqlite
```

Keep the storage key file (`FEEDGEN_STORAGE_KEY_PATH`) too. The copy is
unreadable without it, and the upgrade does not change the key. The file
holds private posts. Protect the copy as you protect the database, and keep it
out of ordinary backups unless you have approved that.

The feed generator sets no journal mode, so SQLite uses its default rollback
journal. After a clean stop, no journal file should sit beside the database.
This is expected from the default and was not checked.

You know the copy worked when both digests are equal.

Then note the schema version. It is stored in the database as `user_version`.
A build from before this upgrade is at 9 or lower. A SQLCipher shell reads it
with the storage key:

```sh
sqlcipher /backup/feedgen-before-november.sqlite
```

```sql
PRAGMA key = "x'<the 64 hexadecimal characters of the storage key file>'";
PRAGMA user_version;
```

The key file holds the 64 characters, with or without a final newline. Do not
include the newline. The feed generator uses this key pragma on open, with the
characters in lower case.

You know it worked when `PRAGMA user_version;` prints a number from 1 to 9.
With a wrong key it cannot print a number. This command was not run when the
page was written, because no SQLCipher shell was available. Use a SQLCipher
build that matches the one the feed generator links.

### 6. Copy the service's stores {#step-6}

This upgrade adds no migration to the service's stores. Copy them anyway, for
step 7 and for a rollback. Copy everything that
[Backup](/operator/operations#backup) lists, together, while the service is
stopped.

You know it worked for the `sqlite` backend when
`sqlite3 <copy of service.sqlite> 'PRAGMA integrity_check;'` answers `ok`, and
`tar -tzf <archive> | grep -c '/stratos.sqlite$'` prints the same number as
`ls "$STRATOS_DATA_DIR"/actors/*/*/stratos.sqlite | wc -l`. For the `postgres`
backend, the dump ends with the comment `-- PostgreSQL database dump complete`,
which `pg_dump` writes last. The `sqlite` checks were run on scratch files, not
on a real store. The `postgres` check was not run.

### 7. Delete earlier-spelling rows in the service's stores {#step-7}

The service does not convert stored values. These rows stay in the earlier
spelling after the upgrade.

| Store                                             | What is in the earlier spelling                  | Effect after the upgrade                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `stratos_backlink.linkTo` in each per-actor store | The subject of a like or repost                  | An earlier row is never matched to a new-form subject, never rewritten and never an error. The one-like-per-subject check does not see it. |
| `moderation_label.subjectKey` in the label log    | The subject of a label on a space post           | The log is append-only. A label is served as stored and never matches a new-form URI. A new label on an earlier subject is refused.        |
| Stored record content                             | A reply parent or root, an embed, a like subject | Never rewritten. A reply with an earlier parent or root is refused on write.                                                               |

The owner decided that staging data is disposable. In staging, delete the
earlier rows of the first two stores now: after step 4 stopped the service and
before step 10 starts it.

Marks:

- Staging: **READY**.
- Any other deployment: **PENDING AUTHORIZATION**. No one has decided to delete
  earlier rows there. Skip this step.

First count the rows, and note the numbers. With the `sqlite` backend:

```sh
sqlite3 "$STRATOS_DATA_DIR/service.sqlite" \
  "SELECT count(*) FROM moderation_label WHERE subjectKey LIKE 'at://%' AND subjectKey LIKE '%/space/%';"
for store in "$STRATOS_DATA_DIR"/actors/*/*/stratos.sqlite; do
  sqlite3 "$store" "SELECT count(*) FROM stratos_backlink WHERE linkTo LIKE 'at://%' AND linkTo LIKE '%/space/%';"
done | awk '{ total += $1 } END { print total }'
```

Then delete them:

```sh
for store in "$STRATOS_DATA_DIR"/actors/*/*/stratos.sqlite; do
  sqlite3 "$store" "DELETE FROM stratos_backlink WHERE linkTo LIKE 'at://%' AND linkTo LIKE '%/space/%';"
done
sqlite3 "$STRATOS_DATA_DIR/service.sqlite" \
  "DELETE FROM moderation_label WHERE subjectKey LIKE 'at://%' AND subjectKey LIKE '%/space/%';"
```

The statements were run against scratch SQLite files with the same table and
column names. They removed the earlier-spelling rows and kept a new-form row, a
custody row and an account subject. They were not run against a real store. No
Postgres form was run. With Postgres, quote the column names (`"linkTo"`,
`"subjectKey"`) and run the `stratos_backlink` statement in each actor schema.
An actor schema is named `actor_` followed by 12 hexadecimal characters.

You know it worked when the two count commands above both print `0`.

### 8. Change the feed generator's settings {#step-8}

| Setting                                                                                                                              | Status                                                    | Mark  |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----- |
| `FEEDGEN_SPACE_WRITE_RESERVE_BYTES`                                                                                                  | Optional. Default: half of `FEEDGEN_PROJECTION_MAX_BYTES` | READY |
| `FEEDGEN_STAGE_TARGET_MAX_ROWS`, `FEEDGEN_STAGE_GLOBAL_MAX_ROWS`, `FEEDGEN_STAGE_TARGET_MAX_BYTES`, `FEEDGEN_STAGE_GLOBAL_MAX_BYTES` | Not read. A set one is ignored                            | READY |

The reserve is the number of bytes that compaction keeps free for space writes.
It must be a whole number above zero and below `FEEDGEN_PROJECTION_MAX_BYTES`.
Any other value stops startup with
`invalid Feedgen NG projection retention configuration`. The default for a
maximum of 1,073,741,824 bytes is 536,870,912 bytes. The `ephemeral` profile has
a fixed 16 MiB maximum and so an 8 MiB default reserve.

Remove the four `FEEDGEN_STAGE_*` variables from the feed generator's
environment files. They do nothing. Set the reserve only if you want a value
other than the default.

You know it worked when `grep -n FEEDGEN_STAGE_ <environment file>` prints
nothing for each environment file of the feed generator. The feed generator
does not log the reserve. A value it refuses shows at step 10, when it does
not start.

### 9. Deploy the new builds {#step-9}

Put the new service build and the new feed generator build in place together.
If your platform starts a build when it deploys it, start the service first and
the feed generator second, as step 10 says.

You know it worked when the image tag and digest, or the commit, of each build
in place differ from the ones you recorded in step 1.

### 10. Start the service, then the feed generator {#step-10}

Start the service. Wait until
`curl -s -o /dev/null -w '%{http_code}\n' "<stratos origin>/health"` answers
`200`. Then start the feed generator. It migrates its database on start. See
[The feed generator database](#the-feed-generator-database) for what the
migrations do.

You know it worked when the service answers `200` and the feed generator's
`/health` reaches `200` after the label log is read. Until then the feed
generator's `/health` answers `503`. That is expected. If it does not answer at
all, the feed generator did not start: read its standard error.

## After the window

### 11. Rebuild and deploy Clubhouse and the webapp {#step-11}

Both apps bundle the client library, which forms and parses space URIs. Rebuild
both from the same commit as the service.

Clubhouse also reads the room-to-space map from
`VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON`. It is a JSON object that maps a room ID
to a space URI. Each value must be a space URI in the new spelling.

```sh
VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON='{"general":"at:space/did:web:stratos.example.com/zone.stratos.space.feed/general"}'
```

Write one entry for each room. The key is the room ID. In the value, replace
`did:web:stratos.example.com` with your service DID and `general` with the name
of that room's boundary. Vite embeds this value in the browser bundle, so a
change needs an image rebuild. Mark: **READY**.

What members see when a value is not a space URI, or the setting cannot be
read:

- A signed-in member whose room status says `pds` custody sees the alert
  `Posting is not set up for the room "<room id>": the space it was given is not
a valid space address. Ask whoever runs this Clubhouse to correct it.` Posting
  or deleting a post there answers `Posting needs service configuration for this
room.` and sends nothing.
- A setting that is not valid JSON, or JSON that is not an object, configures no
  room. A signed-in member whose room status says `pds` custody sees the alert
  `Posting is not set up because the room spaces setting could not be read; ask
whoever runs this Clubhouse to correct it.` in every room. Posting or deleting
  a post answers `Posting needs service configuration for this room.`
- With no setting at all, nobody sees an alert, and a `pds`-custody member's post
  or delete answers `Posting needs service configuration for this room.`
- A member whose records are on Stratos, a signed-out visitor and a member whose
  custody is not known yet see no alert. Members on Stratos can still post.

A `?topic=` link that is not in the new spelling does not open. The room opens
without a topic and shows `This topic link cannot be opened.` A member in a room
whose records are on their own PDS deletes a post through
`com.atproto.space.deleteRecord`, and only a post in the room's configured
space. For a post in any other space Clubhouse answers `This post cannot be
deleted from here. Your posts are kept in a different place from this one.` and
sends nothing.

You know it worked when a Stratos-custody test member posts from the webapp and
from Clubhouse, and both posts reach the feed. A member with `pds` custody who
opens a room sees no configuration alert. That last check needs such a member
who can sign in. Posting as that member cannot work yet.

### 12. Publish the space type declaration {#the-space-type-declaration}

The declaration is the lexicon record `zone.stratos.space.feed`. A member's PDS
resolves it when the member enrolls, before it grants the space scope.

Enrollment itself sends no space URI and calls no `com.atproto.space.*` method.
Stratos always requests the space scope, and it decides custody from the scope
the PDS granted. For a new enrollment, a grant that can read, and create every
collection of this service's space type, gives `pds` custody. Any other grant
gives `stratos` custody. A later authorization does not change custody. So
enrollment does not depend on the host accepting the `at:space/` spelling. It
depends on the host accepting the declaration.

A spaces PDS older than the November release requires a `name` member and
refuses a declaration without it. This is read from the October PDS source
(`lex-document`, the space schema). In that source, the consent screen
resolves the declaration. When it cannot, the authorization ends with
`invalid_scope`, and Stratos records no enrollment. The November release
accepts `name` beside `title` and ignores it. `title` is optional there, from 1
to 64 UTF-8 bytes.

There are two ways to publish the declaration. Neither is recommended here.

| Way                        | Declaration holds                      | A member on a spaces PDS older than the November release                                                                                                                                                                                |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both during the transition | `title` and `name`, with the same text | Expected: the host grants the space scope, and the member is enrolled with `pds` custody. Then the member cannot post or be synced until the host accepts the `at:space/` spelling. Not observed.                                       |
| `title` only               | `title`                                | The host refuses the declaration, and the authorization ends with `invalid_scope`. The member is not enrolled with any custody, because Stratos always requests the space scope. Read from the October PDS source and the service code. |

A member on a November host is expected to be enrolled with `pds` custody under
either form. Such a member cannot post or be synced yet either, because the
upstream reference at the pinned revision does not accept the `at:space/`
spelling. The repository file holds `title` only. The choice of how to publish
is the operator's, and it is open. The step 2 list tells you how many members
each form affects.

Publishing is a write to the repository of the DID that the
`_lexicon.space.stratos.zone` DNS record names. Mark:
**PENDING AUTHORIZATION**. The repository has the declaration file and no
script that publishes it. A PDS resolves the published record, so publish
again whenever the file changes. A member who got a partial grant may need
to authorize again after the declaration lists all three collections.

You know it worked when the published record holds the members of the form you
chose:

```sh
curl -s "<lexicon PDS>/xrpc/com.atproto.repo.getRecord?repo=<lexicon DID>&collection=com.atproto.lexicon.schema&rkey=zone.stratos.space.feed" \
  | jq '.value.defs.main | {title, name, collections}'
```

`<lexicon DID>` is the DID in that DNS record (`did=<did>`). `<lexicon PDS>` is
the origin of the PDS that hosts its repository. This command was not run
against a published record. A full check is a test member on each kind of host
who completes enrollment. That needs a spaces PDS.

### 13. Check the upgrade {#after-the-upgrade}

These checks need no spaces PDS.

| Check                                                   | Command or place                                                                                                                        | Mark  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| The service answers                                     | `curl -s -o /dev/null -w '%{http_code}\n' "<stratos origin>/health"` answers `200`                                                      | READY |
| The service DID document offers no `#atproto_pds` entry | `curl -s "<stratos origin>/.well-known/did.json" \| jq '.service[].id'` answers `"#stratos"`                                            | READY |
| The feed generator is open                              | `curl -s -o /dev/null -w '%{http_code}\n' "<feed generator origin>/health"` answers `200`                                               | READY |
| The new pass output is in use                           | `curl -s "<feed generator origin>/health" \| jq '.pdsSpaceSyncLastPass'` shows `unchanged`, `replaced` and `cleared`, and no `rejected` | READY |
| A Stratos-custody post reaches the feed                 | An authenticated `getFeed` request as an enrolled test viewer. See [Run the feed generator](/operator/feedgen-ng)                       | READY |
| The migrations pass their tests                         | `cargo test --locked -p stratos-feedgen-ng --lib store::migrations`, from a checkout of the deployed commit                             | READY |
| The spaces contract tests pass                          | `pnpm exec vitest run --config test/spaces-alignment/vitest.config.ts`, from a checkout of the deployed commit                          | READY |

`pdsSpaceSyncLastPass` is absent before the first pass. A new pass starts 30
seconds after the last one ends.

Before the label log is read to its head, the feed generator's `/health`
answers `503`. That is expected after migration 10.

With members who have `pds` custody, `pdsSpaceSyncHealthy` is `false` after the
upgrade. That is expected. See [What cannot work yet](#what-cannot-work-yet).

## The feed generator database

The new build opens the file and migrates it on start. Each migration is one
transaction. A migration that fails leaves the version where it was.

**Migration 10** deletes:

- every post, post boundary and suppression marker whose URI is not a
  Stratos-custody URI, and every interaction whose URI or subject is not one.
  These are the posts and interactions of members with `pds` custody, and the
  likes and reposts of their posts;
- every row of the four staged-page tables (`space_sync_stage`,
  `space_sync_stage_cursor`, `space_sync_pending_verification`,
  `space_sync_stage_lifetime`) and of the space cursor table (`space_cursor`);
- the record-kind takedown subjects whose URI is not a Stratos-custody URI;
- every label cursor row.

It creates the two tables that hold verified state.

**What stays.** Stratos-custody posts and their boundaries, custody interactions
on custody posts, the actor cursors, the enrollment and membership tables,
both generation tables, the projection epoch, the retention metadata, and the
source coverage.

**The label log is read again.** The label cursor is reset, so the feed generator
reads the authority's label log from the start. Account takedowns and takedowns
of Stratos-custody records stay in force meanwhile, because their rows stay.
Feeds are closed until the log has been read to its head. They answer
`503 FeedNotReady`. The feed generator polls every 10 seconds and reads at most
50 pages in a poll. A long log takes several polls.

**Members with `pds` custody do not come back today.** After migration 10 such
a member has no verified state. The feed generator reads them again only
through a whole-repo read, and it sends that read with the member's space in
the `at:space/` spelling. The upstream reference PDS at the pinned revision
and the spaces PDS images that the sandbox pins do not accept that spelling.
So, until the member's host accepts it:

- the member's posts are gone from every feed, and they do not return;
- the member's sync fails in every pass;
- the member cannot post through Clubhouse or the webapp.

[What cannot work yet](#what-cannot-work-yet) says which reason words show
this state. This is read from the code. It was not observed against a host.

When a member's host accepts the spelling, the next whole-repo read is
expected to rebuild that member's posts from the host. Only one whole-repo read
runs at a time across all members, and each member's cycle has a deadline of
60 seconds that includes the wait for that read. With many such members, expect
some to fail with the reason `deadline` in the first passes. A member whose
deadline passes while it waits for its turn starts no cooldown, so the next
pass tries it again. A member whose deadline passes during its whole-repo read
gets no whole-repo read for 10 minutes. This is read from the code. It was not
observed.

**Likes do not return.** The likes and reposts that Stratos-custody members made
of PDS members' posts came through the actor stream. The migration does not
reset the actor cursor, so the stream does not send them again. They are lost.

**Migration 11** drops the four staged-page tables, the space cursor table and
the three triggers on the staged-page tables. The `stage_*` keys that an older
build wrote into the retention metadata stay in the file, and nothing reads
them. The version becomes 11. A second start changes nothing.

**An older binary refuses the migrated file.** A binary that knows fewer
migrations does not open a database above its latest version. The way back is
the copy you made in step 5.

You know it worked when the step 5 commands, run against `$FEEDGEN_SQLITE_PATH`
instead of the copy, print `11`, and the feed generator's `/health` reaches
`200` after the label log is read. Mark: **READY**.

## Monitoring

`GET /health` reports `pdsSpaceSyncLastPass`. The members are `boundaries`,
`membershipFailures`, `targets`, `promoted`, `unchanged`, `replaced`, `cleared`,
`deferred` and `targetFailures`. The old member `rejected` is gone. The log line
`event=pds_space_sync_pass` carries the same counts.

A failed member logs `event=pds_space_target_failed kind=<reason>`, except a
failure with the reason `member_generation`, which logs no line of its own. A
pass with failed members logs one `event=pds_space_target_failures` line. It
holds a `<reason>=<count>` pair for each reason that occurred in that pass, in
alphabetical order, `member_generation` included; a reason with no failure has
no pair. The 27 reason words are:

```text
invalid_space_mac  invalid_space_uri  invalid_credential  bad_space_audience
repo_not_found  repo_takendown  repo_suspended  repo_deactivated
invalid_cursor  mac  kem_key  record_refused  archive  repo_over_budget
digest  deadline  replacement_cooldown  credential  transport  page
cursor_stalled  store  target_capacity  cooldown_capacity  member_generation
task  other
```

[Run the feed generator](/operator/feedgen-ng#pass-output-and-reasons) says what
each word means.

The `outcome` label of `stratos.feedgen.space_sync.outcomes` has the values
`pass`, `member_ok`, `member_unchanged`, `member_replaced`, `member_cleared`,
`member_error` and `member_deferred`. Step 3 lists what was removed.

Mark: **READY**. You know it worked when an alert query on a reason word
returns a series after a failure.

## Sync behaviours to know

Two behaviours of the new sync can remove or keep posts in ways you may not
expect. Both are on [Run the feed generator](/operator/feedgen-ng#verified-sync-of-pds-members)
and in [Known gaps](/architecture/supported-versions#known-gaps).

- **`RepoNotFound` clears a member.** An answer of `RepoNotFound` with status
  400 from a member's host clears that member's posts and interactions in that
  space. The answer carries no MAC. The TLS connection to the host that Stratos
  named is its only protection. A host gives the same answer when the account
  does not exist there. So an enrollment that still names a host that deleted a
  migrated account clears that member's posts.
- **Cached posts of a taken-down account stay served.** A host answer of
  `RepoTakendown`, `RepoSuspended` or `RepoDeactivated` fails the member and
  deletes nothing. The cached posts of that member stay in the feeds until a
  takedown label from the authority's label log removes them.

## What cannot work yet

Everything that sends a space URI to a member's host needs that host to accept
the `at:space/` spelling. It cannot work until then.

- Sync of a member with `pds` custody: the member's posts stay out of the feeds.
- Posting, reading and deleting a space record on a member's PDS from Clubhouse
  and the webapp.

Mark: **BLOCKED**. The condition is a spaces PDS that accepts `at:space/` in
space parameters. The upstream reference at the pinned revision accepts only the
earlier spelling, and the spaces PDS images that the sandbox pins are from
October and refuse the new spelling. See
[Supported versions](/architecture/supported-versions).

Enrollment is not in this list. It sends no space URI to the host. What it
needs from the host is in [The space type declaration](#the-space-type-declaration).

The status shows the blocked state like this. With members on such a host,
`pdsSpaceSyncHealthy` is `false` and `targetFailures` in `pdsSpaceSyncLastPass`
is close to `targets`. After migration 10, each such member's cycle is a
whole-repo read. The feed generator looks up the member's `#atproto_kem` key
before it sends any request to the host. The reason of a failed read is:

- `kem_key`, when the member's DID document has no usable `#atproto_kem` key,
  or the document is not found. No request is sent to the host. Expect this
  reason for every member whose DID document has no `#atproto_kem` entry;
- `invalid_space_uri`, when the host answers with that error name;
- `transport`, when the request does not complete;
- `other`, for any other error name.

A failed whole-repo read gives that member no whole-repo read for 10 minutes.
In the passes between, the member fails with `replacement_cooldown`. A member
whose DID document lookup does not complete, or answers an error other than not
found, is counted as `deferred`. That is not a failure, and it starts no
cooldown.

This is read from how the feed generator maps lookups and host answers. It was
not observed against a host.

## Rollback

Go back when the new pair cannot work and the cost of waiting is higher than the
cost of the loss below. Mark: **READY**, except step 6.

1. Stop the feed generator, then the service, as in [step 4](#step-4). You
   know it worked when the lock command prints `released` and the service no
   longer answers `200`.
2. Move the migrated feed generator file aside. Do not delete it. Restore the
   copy from [step 5](#step-5), and keep the same storage key file:

   ```sh
   mv "$FEEDGEN_SQLITE_PATH" /backup/feedgen-after-november.sqlite
   cp -p /backup/feedgen-before-november.sqlite "$FEEDGEN_SQLITE_PATH"
   sha256sum "$FEEDGEN_SQLITE_PATH" /backup/feedgen-before-november.sqlite
   ```

   You know it worked when both digests are equal.

3. If you ran [step 7](#step-7), restore the service's stores from the copy of
   [step 6](#step-6), as [Backup](/operator/operations#backup) describes. You
   know it worked when the step 7 counts answer the numbers they had before
   the deletion, not `0`. Skip this step if you did not run step 7.
4. Deploy the pre-upgrade service, feed generator, Clubhouse and webapp builds
   that you recorded in step 1. They must be a set, because the audience, the
   presentation scheme and the URI spelling changed together. You know it
   worked when each deployed identifier equals the one from step 1.
5. Restore the earlier room-space setting. The pre-upgrade Clubhouse image
   already holds the value it was built with. If you rebuild Clubhouse instead,
   set `VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON` to the value from step 1. You know
   it worked when a test member with `pds` custody opens each room and sees no
   configuration alert.
6. If you published a new declaration, publish the earlier one again. Rolling
   back the binaries does not unpublish it. Mark: **PENDING AUTHORIZATION**.
   You know it worked when the `getRecord` command in
   [The space type declaration](#the-space-type-declaration) shows the earlier
   record.
7. Start the service, then the feed generator. You know it worked when both
   `/health` routes answer `200`. The feed generator's answers `200` only once
   it is ready.

**What is lost.**

- Everything the new feed generator wrote after the copy: posts, interactions,
  sync positions and verified state. The older build reads again from its
  restored cursors, as far as Stratos still holds the events. This was not
  rehearsed.
- If you restored the service's stores in step 3, everything the new service
  wrote after the copy is lost, such as records, enrollments and labels.
- If you did not restore them, rows that the new service wrote in the new
  spelling stay in the service's stores. The older build was not tested against
  them. Expect it not to match them.

## What was rehearsed

Rehearsed, with real encrypted stores and the real migrations:

- `cargo test --locked -p stratos-feedgen-ng --lib store::migrations` ran 22 tests. All
  passed. They include
  `purges_every_space_row_and_keeps_everything_else_byte_for_byte`,
  `the_purge_is_all_or_nothing`,
  `a_purge_that_fails_after_its_deletes_leaves_version_nine_and_every_row`,
  `the_label_cursor_reads_zero_after_the_migration`,
  `an_encrypted_file_migrates_once_and_stays_migrated_across_reopens`,
  `a_version_ten_database_with_rows_in_the_five_tables_reaches_eleven_and_loses_only_them`,
  `a_failure_after_the_drops_rolls_back_to_version_ten_through_apply_migrations`,
  `a_database_at_version_twelve_is_refused_and_left_alone` and
  `a_verified_sync_of_a_member_works_end_to_end_on_a_migrated_file_store`.
- The audience and presentation checks of the service verifiers, with the
  pinned upstream package as the oracle, at package level.

Not rehearsed:

- No older binary opened the migrated file. The refusal is tested with a
  database whose version is above the latest the code knows.
- The test files are made by applying the migrations of this build up to version
  9 and adding rows the way an older build wrote them. No kept production
  database was used.
- A rollback was not run end to end.
- The feed generator's first sync of many PDS members after the migration was
  not run.
- Nothing ran against a real PDS. See
  [Supported versions](/architecture/supported-versions).
