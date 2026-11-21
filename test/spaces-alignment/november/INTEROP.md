# Interop checklist

For the person who runs the sandbox suites. It covers what to run today, and
what to do, in order, the day an upstream PDS accepts the `at:space/` record
and space spelling. No part of the November contract has been run against a
host: the PDS images the sandbox pins refuse the new spelling.

Every command below runs from the repository root, needs rootless Docker, a
clean checkout at a committed SHA, a report directory that does not exist, and
either the two-review receipt (`test/spaces-alignment/README.md`) or GitHub Actions with
`--ci-evidence`. Replace `<sandbox checkout>`, `<receipt file>` and
`<new directory>` with real paths.

## 1. Today

### The ordinary-custody run

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite ordinary-custody \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

It signs one user of the ordinary PDS in, posts through the service as a
Stratos-custody member, requires that post in the feed from the Rust feed
generator, checks that a user of another boundary is denied, deletes the post
and requires it gone. Its receipt lists five assertions and says it covers
ordinary custody only. It proves nothing about PDS custody, space credentials
or the spaces PDS, and it never replaces the baseline. No run of it is recorded
yet, so what it does on a real stack is unknown.

### The baseline diagnostic

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

The baseline is a diagnostic here, never acceptance. Eight of its ten
assertions touch PDS custody, which the pinned hosts cannot serve in the new
spelling, so it is expected to fail. The driver prints each assertion name when
the step that proves it ends, and `failure.json` lists those names under
`assertionsReached`. The steps run in this order: `browser-oauth`,
`pds-custody`, `publication-feed`, `space-lexicon`, `pds-space-grant`,
`public-private-blob-denied`, `authenticated-space-blob`, `stratos-custody`,
`unrelated-boundary-denied`, `boundary-isolation`.

- Expected: the run stops at or before `pds-custody`, the first assertion that
  needs a PDS-custody write in the new spelling. `browser-oauth` may stop it
  earlier, because sign-in asks the spaces PDS for the space scope and the
  pinned hosts refuse a space declaration without `name`.
- Not reached on a stop there: every assertion after the one reached.
- Unknown: where exactly it stops. Read `assertionsReached` and record it.

## Not covered by any test today

These assertions of the earlier suites have no test in the repository now.
`assertion-manifest.json` marks each one `uncovered`, and only a journey of the
prepared suite carries it. Treat each as unprotected until a test or a driver
exists.

- `staging-limits:service-responsive`: the feed generator answers `/health`
  within two seconds while a sync writes to the store. Journey
  `health-answers-while-a-sync-writes`. A test would hold a store write open,
  request `/health`, and require the answer within that bound.

## 2. The day a host accepts the new spelling

Do these in order. Stop at the first step that fails and keep its output.

1. **Pin the artifact.** Choose one upstream commit and one set of npm package
   versions whose syntax package, validators and PDS accept `at:space/`. Neither
   revision the manifest names today does: both serialize the earlier spelling.
   Build the PDS image of that commit the way the runner does
   (`test/spaces-alignment/build-alpha-pds.ts`), with the same label, so a later
   rebuild on the same machine can reuse the layer cache:

   ```sh
   git clone https://github.com/bluesky-social/atproto.git <upstream checkout>
   git -C <upstream checkout> checkout --detach <revision>
   docker build --file <upstream checkout>/Dockerfile \
     --label org.opencontainers.image.revision=<revision> \
     --iidfile pds-image.id --tag stratos-reference-pds:probe <upstream checkout>
   cat pds-image.id
   ```

   The last line prints `sha256:` and 64 hex digits. That is the local image ID
   that `docker build --iidfile` writes, not a registry digest. It is the value
   for `uriProbe.imageDigest` and for `--pds-image-digest`. Write the revision,
   the package versions and the image ID down before anything else.

2. **Fill the manifest** `test/spaces-alignment/november/sources.json`:
   `reference.revision` and `reference.releaseAnchor` (neither may be a revision
   on `legacyUriOnly`), each package's `version`, `integrity` and
   `tarballSha256`, and `referenceHost.sha256` with the SHA-256 of `Dockerfile`
   and `pnpm-lock.yaml` at that revision. The runner refuses to build the
   reference host while those two hashes are empty or the revision is on the
   legacy-only list or is the revision the October file pins. The values come
   from these commands, one package at a time:

   ```sh
   git -C <upstream checkout> show <revision>:Dockerfile | sha256sum
   git -C <upstream checkout> show <revision>:pnpm-lock.yaml | sha256sum
   npm view <package>@<version> dist.integrity
   npm pack <package>@<version> --pack-destination <scratch directory>
   sha256sum <scratch directory>/*.tgz
   ```

3. **Probe.** Start the image alone, then ask it to parse a space URI in the new
   spelling. The host validates query parameters before it checks
   authentication, so the request needs no account:

   ```sh
   docker run --rm --detach --name stratos-reference-pds-probe \
     --publish 127.0.0.1:2583:3000 \
     --env PDS_HOSTNAME=localhost --env PDS_DEV_MODE=true \
     --env PDS_JWT_SECRET=<random hex> --env PDS_ADMIN_PASSWORD=<random text> \
     --env PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=<64 hex> \
     --env PDS_DID_PLC_URL=<local PLC directory URL> \
     --env PDS_DATA_DIRECTORY=/app/data \
     --env PDS_BLOBSTORE_DISK_LOCATION=/app/data/blocks \
     --env PDS_INVITE_REQUIRED=false --env PDS_CRAWLERS= \
     "$(cat pds-image.id)"
   curl --silent --write-out '\n%{http_code}\n' \
     'http://127.0.0.1:2583/xrpc/com.atproto.space.getRecord?space=at:space/did:web:stratos.example/zone.stratos.space.feed/general&repo=did:plc:spikespiegelbebopcrewabc&collection=zone.stratos.feed.post&rkey=bebop'
   ```

   A 401 answer means the host parsed the space URI and asked for
   authentication. A 400 `InvalidRequest` answer about `space` means it refuses
   the spelling: stop here. Then, on the same host, create an account and a
   session, call `com.atproto.space.createSpace` (space type
   `zone.stratos.space.feed`, a personal-space policy),
   `com.atproto.space.createRecord` in the space it returns,
   `com.atproto.space.getRecord` at the URI it returns, and
   `com.atproto.space.getDelegationToken` then
   `com.atproto.space.authorizeSpaceSync` for that space. Save the four answers in
   one receipt file. The probe holds when the space, the record URI and the
   credential `sub` all start with `at:space/`, and the record read back has the
   same URI. Fill `cutoverEvidence.uriProbe`: `artifactRevision`, `imageDigest`
   (the image ID from step 1), `packageVersions`, `recordUri` (from
   `createRecord`), `credentialSubject` (the credential `sub`) and
   `receiptSha256` (`sha256sum` of the receipt file). Then set
   `referenceSupportsTargetUri` to `true` and `cutoverEvidence.status` to
   `fulfilled`. `test/spaces-alignment/november/november-sources.test.ts` rejects a ready manifest
   whose probe is partial or names a legacy-only artifact. Not verified: none of
   these commands has been run, and the PDS settings follow
   `templates/reference-pds.yaml`. Use a local PLC directory, never the public
   one.

4. **Build the reference host.** The runner builds it from the upstream
   repository root `Dockerfile` at `reference.revision` whenever a suite that
   needs it is selected, and refuses to if step 2 or 3 is incomplete.
   `uriProbe.imageDigest` is optional to that check, so
   `standard-credential-transport` and `rust-production-interop` build and run a
   reference host with no digest named. `november-interop` needs
   `--pds-image-digest`, equal to `uriProbe.imageDigest`. Whenever
   `--pds-image-digest` is given, the runner also requires its own build's image
   ID to equal it. A rebuild from source need not reproduce the ID of step 1: a
   changed base image or a build without the layer cache gives a new one. If the
   IDs differ, the run stops with `The built reference PDS image differs from
--pds-image-digest`, removes the image it built, and does not report that
   image's ID. Build and probe as in steps 1 and 3 on the machine that runs the
   suite, straight before the run, so the runner's build can reuse the layer
   cache. If the IDs still differ, this artifact cannot be run as
   `november-interop`; record that and keep the reports. The service definition is
   `test/spaces-alignment/templates/reference-pds.yaml`. Check its container
   command and data paths against the `pds` stage of the `Dockerfile` at the
   pinned revision; they follow the layout of the earlier image and have not
   been compared with the new one.
5. **Run the upstream migrations on a disposable database.** Start the built
   image once against an empty data directory and once against a copy of a kept
   database, with the settings of step 3 and a mounted data directory:

   ```sh
   docker run --rm --volume <empty directory>:/app/data <step 3 settings> "$(cat pds-image.id)"
   docker run --rm --volume <copy of a kept data directory>:/app/data <step 3 settings> "$(cat pds-image.id)"
   ```

   The PDS applies its own migrations when it starts. Read the migration list at
   the pinned revision: the account manager's `011` and `012` and the actor
   store's `007` to `009` were the ones the earlier step needed, and a newer
   revision may add more. Not verified: these commands have not been run.

6. **Run the baseline.** All ten assertions must pass; the receipt is
   acceptance only for the baseline.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

7. **Run each other suite**, one run each, each with a new report directory and
   fresh accounts. Save every `receipt.json` and `failure.json`.

**`ordinary-custody`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite ordinary-custody \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`delegation-transport`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite delegation-transport \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`credential-lifetime`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite credential-lifetime \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`client-custody`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite client-custody \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`space-delete`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite space-delete \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`feed-errors`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite feed-errors \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`service-admission`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite service-admission \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`standard-credential-transport`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite standard-credential-transport \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

**`rust-production-interop`**

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite rust-production-interop \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

8. **Run `november-interop`.** It starts only with `--pds-image-digest` naming
   the image from step 1, and only when the manifest is ready and its probe
   records the same digest. It has no driver for some journeys yet (see the
   journey list); until each has one the run stops with the names it lacks.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite november-interop \
  --review-receipt <receipt file> \
  --report-dir <new directory> \
  --pds-image-digest sha256:<digest>
```

## The journeys

The `november-interop` suite names one assertion per journey. Each item says the
row it closes, what it proves, what the repository's own tests lead us to
expect, what only a host can show, which suite carries it today, and what to
save. Walk them in this order.

### 1. `canonical-uri-at-each-boundary`

- Closes: A pinned upstream build accepts the new space spelling: a record created on it comes back in that spelling, and a credential for it names the same space.
- Proves: Create a record on the reference host, read back the URI it returns, read the record at that URI, and mint a credential: the URI, the record address and the credential subject all use the at:space/ spelling.
- Expected: Stratos recognises only the at:space/ spelling and converts nothing, so a host that returns the new spelling should round-trip.
- Unknown: Whether the build you pinned returns the new spelling from create and read. Nothing has been observed from any host.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 2. `ordinary-custody-create-feed-delete`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A Stratos-custody member on an ordinary PDS posts through the service, the post appears in the feed from the Rust feed generator, a member of another boundary is denied, and the delete removes it.
- Expected: Should pass: the journey touches no space URI and no credential from the spaces PDS.
- Unknown: The suite has never run; the first run may show a stack or driver fault.
- Command: Run `ordinary-custody` (command below); it carries this journey in a ported form.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 3. `two-authors-on-one-host`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: Two PDS-custody members who share one reference host each have their own seeded record read with one Stratos credential presented to their own repo, and a presentation addressed to one member is refused for the other member's repo.
- Expected: Each read is addressed to the author, never to the authority. The credential names the space, not a member; the presentation names the repo it is for, and the host refuses it for any other repo.
- Unknown: How the host answers a credential presentation in the tagged signature form.
- Command: Run `standard-credential-transport` (command below); it carries this journey in a ported form, as do `rust-production-interop`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 4. `authors-on-separate-hosts`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: Two PDS-custody members on two different hosts are both ingested and served in one boundary feed, each read from its own host.
- Expected: Host discovery follows the authority override, then the #atproto_pds entry of the member DID document.
- Unknown: The template provides one reference host; a second host needs its own service and routes.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 5. `schema-resolution-and-explicit-grants`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: The host resolves the space type declaration during OAuth, grants the space scope, and accepts a PDS-custody write made under that grant.
- Expected: The sandbox declaration fixture carries name and title and the three collections of the repository declaration, which carries title only.
- Unknown: Whether the host in use still requires name, how it answers the space scope string, and whether it refuses a write without the grant: no driver writes without it.
- Command: Run `baseline` (command below); it carries this journey in a ported form.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 6. `inspector-reads-own-record-through-oauth`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: The webapp inspector reads the signed-in member own PDS-custody record with that member OAuth grant.
- Expected: The inspector classifies the address, then sends exactly one com.atproto.space.getRecord to the signed-in member's own PDS for their own repo, and no request for another author's space record or for an address it refuses.
- Unknown: The host response to the OAuth-bound read.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 7. `other-author-snapshot-without-direct-request`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A viewer sees another author post only as a labeled feed snapshot, and no request goes from the viewer to that author PDS.
- Expected: The feed generator serves from its own projection.
- Unknown: Needs a request log from the host or the sandbox proxy to show no direct request; the baseline does not record one.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 8. `custom-mint-reads-from-reference-pds`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A credential minted by Stratos, as space authority, reads a member's record from the reference host.
- Expected: The credential names the authority as issuer and the space as subject, binds the presentation key in cnf.kid, carries no aud, and is signed with the authority key; the #atproto_pds audience is on the delegation it was exchanged for. The receiver checks the signature against the authority DID document and calls no Stratos method.
- Unknown: Whether the host accepts a credential minted by a foreign authority. This is the question the earlier probe left open.
- Command: Run `standard-credential-transport` (command below); it carries this journey in a ported form, as do `rust-production-interop`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 9. `upstream-standard-mint-control`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: The host's own standard credential exchange works in the same stack, so a failure of the custom mint is not a stack fault.
- Expected: For a space whose authority is the host, its com.atproto.space.authorizeSpaceSync returns a credential for a delegation token and a P-256 credentialKey. No driver calls it: the reference-host drivers exchange through the Stratos method zone.stratos.space.getSpaceCredential.
- Unknown: The host exchange route at the pinned build.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 10. `wrong-key-and-wrong-owner-denied`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A presentation signed with the wrong key, and a presentation addressed to one owner sent to another owner's repo, are refused by the reference host.
- Expected: Both are refused with an authentication error, never a record.
- Unknown: The host error words.
- Command: Run `standard-credential-transport` (command below); it carries this journey in a ported form, as do `rust-production-interop`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 11. `current-delegation-and-client-attestation-accepted`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A delegation with the #atproto_pds audience is accepted by the custom mint, and an allow-listed client attestation is accepted.
- Expected: The service verifier accepts the current audience and the allow-listed attestation.
- Unknown: How the host issues the delegation for an OAuth session. No driver presents a client attestation, so no suite carries this journey; delegation-transport and credential-lifetime perform the delegation half only.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 12. `invalid-jwt-signature-refused-by-receiver`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A credential whose JWT signature is invalid is refused by the receiving verifier on the reference host.
- Expected: Refused before any record is read.
- Unknown: The host response.
- Command: Run `standard-credential-transport` (command below); it carries this journey in a ported form.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 13. `renewal-and-revoked-member-denied`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A credential renews with a fresh key, and after the member is removed a renewal is denied while a credential already issued still reads until it expires.
- Expected: Renewal after removal is denied by Stratos; a credential already issued lapses at its expiry.
- Unknown: Whether the host honours removal sooner than expiry. No host route announces removal.
- Command: Run `standard-credential-transport` (command below); it carries this journey in a ported form, as do `rust-production-interop` and `credential-lifetime`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 14. `non-member-forged-boundary-write-never-indexed`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A non-member's write with a forged boundary lands in the host repo and is never indexed or served by the feed generator.
- Expected: The feed generator reads the boundary from Stratos membership state, never from the record.
- Unknown: Whether the host lets a non-member write at all. That is the next journey.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 15. `host-does-not-authorize-write-against-authority`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: Whether the host checks the space authority or membership on a write: a second account writes into a space whose authority cannot be resolved.
- Expected: Stratos treats any record in a member repo as an unverified claim until its own membership and boundary state agree.
- Unknown: The open question of the earlier write probe: if the write succeeds, the host authorizes from the caller session scope alone.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 16. `post-uri-and-text-in-real-feed-response`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: The exact new post URI and text appear in a real feed HTTP response, not only on a rendered page.
- Expected: The feed response carries the URI the write returned: at:space/ for a PDS-custody post, at:// for a Stratos-custody post.
- Unknown: The URI the host returns for a created record.
- Command: Run `baseline` (command below); it carries this journey in a ported form, as do `ordinary-custody`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 17. `nonterminal-mac-tamper-never-promoted`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A page with a corrupted commit MAC that is not the terminal page promotes nothing.
- Expected: The feed generator promotes only after every page MAC and the terminal set hash verify.
- Unknown: Needs a way to corrupt one page in transit, for example a proxy in front of the host.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 18. `terminal-set-hash-mismatch-never-promoted`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A terminal page whose set hash does not match the records applied promotes nothing.
- Expected: The set hash of the whole repo, kept from the stored base and updated by each op, must equal the commit's data before anything is promoted.
- Unknown: As above.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 19. `non-post-record-contributes-to-integrity`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A record of a collection the feed does not serve still counts in the integrity hash of the repo.
- Expected: Every record of the repo is hashed, whatever its collection.
- Unknown: How the host orders and pages such records.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 20. `full-page-then-empty-terminal`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A repo that exactly fills a page is followed by an empty terminal page and verifies.
- Expected: A page without a cursor ends the poll, whatever its ops, and only that page's commit is proven and promoted; a page with a cursor is never the last.
- Unknown: Whether the host sends a cursor after a full page and then an empty page, or ends on the full page.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 21. `expired-cursor-replaced-by-verified-star`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: When the host refuses an expired cursor, the feed generator reads a whole-repo archive and replaces the stored state only after it verifies.
- Expected: The archive is read to the end and verified before any stored row changes.
- Unknown: How long the host keeps a cursor and the archive error words.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 22. `crash-restart-reaches-verified-terminal-revision`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: Stopping the feed generator mid-sync and starting it again ends at the verified terminal revision with nothing half-applied.
- Expected: Nothing is promoted until verification ends; a restart resyncs.
- Unknown: The restart timing against a real host.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 23. `host-and-kem-key-rotation`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: After a member moves host or rotates the key the host uses for the encrypted commit data, the next poll refreshes the key once and verifies.
- Expected: One refresh and one new request after a failure with the old key; a stored host other than the target starts a replacement.
- Unknown: How the host publishes the rotated key.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 24. `membership-revoked-mid-poll`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A member removed while a poll is running promotes nothing, other members are untouched, a member added again starts with a fresh generation, and a restart keeps the removal.
- Expected: Each store write checks the generation, so a stale poll changes nothing.
- Unknown: Timing against a real host.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 25. `health-answers-while-a-sync-writes`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: While a poll or a whole-repo replacement of a large member repo writes to the store, the feed generator answers /health within two seconds.
- Expected: No test covers this today. The health handler reads the readiness gate and the scheduler status, not the store.
- Unknown: How long a store write takes on a large real repo, and whether /health waits for it.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 26. `malformed-or-truncated-archive-refused`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A malformed or truncated whole-repo archive is refused and changes nothing.
- Expected: An archive over a limit fails as a unit with nothing written.
- Unknown: What the host sends when its own read fails midway.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 27. `suspension-and-offline-are-not-deletion`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A suspended or unreachable host leaves the member projection in place and does not delete it.
- Expected: A failed target is counted as a failure.
- Unknown: The host error codes for suspension and takedown.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 28. `mixed-cache-migration-preserves-custody`

- Closes: The cache migration keeps custody data, the PDS projection is rebuilt from a verified sync, and a rollback pairs matching versions.
- Proves: A cache that held both custodies before the upgrade keeps the Stratos-custody rows and rebuilds the PDS-custody projection by a verified sync.
- Expected: The migration purges every space row and keeps everything else byte for byte; some of its tests run on encrypted file stores.
- Unknown: A real kept database and the upstream migrations on a disposable database have not been rehearsed.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

## Open questions the earlier probes left

A host answers each of these once; nobody has the answer for the new build.

- Does a host check the space authority or membership on a write? A second
  account writes into a space whose authority cannot be resolved. If the write
  succeeds, Stratos must treat any record in a member repo as an unverified
  claim until its own membership and boundary state agree (journeys
  `host-does-not-authorize-write-against-authority` and
  `non-member-forged-boundary-write-never-indexed`).
- Does a host accept a credential that a foreign authority minted, verified
  against the authority DID document with no call back to Stratos (journey
  `custom-mint-reads-from-reference-pds`)?
- Can the syncer read a member's records from a host it does not control with
  only that credential (journeys `two-authors-on-one-host` and
  `authors-on-separate-hosts`)?
- Does the host's authorization endpoint, not only a pushed request, accept the
  space scope string, and does an ordinary PDS refuse it (journey
  `schema-resolution-and-explicit-grants`)?
- Does the `#atproto_pds` entry of a member's DID document name the host that
  holds the repo, the convention Stratos uses for host discovery (journey
  `authors-on-separate-hosts`)?
- What record URI does a host return for a created record (journeys
  `canonical-uri-at-each-boundary` and `post-uri-and-text-in-real-feed-response`)?

## 3. What to change in the sandbox then

- **The pinned spaces PDS.** The sandbox's `pds-space1` and the Deno suite's
  `pds-spaces` service both pin an image that refuses the new spelling. Move the
  sandbox pin in `test/spaces-alignment/sources.json` to a release whose
  `pds-space1` accepts it, and point the `pds-spaces` image in
  `test/docker-compose.test.yml` at the same digest, then drop the comment there
  saying it refuses the spelling. Not verified: whether the sandbox exposes the
  PDS image as a setting at the pinned version.
- **Whether the fixture still needs `name`.** The sandbox declaration fixture
  `test/spaces-alignment/atmosphere/examples/lexicon-fixtures/zone.stratos.space.feed.json` carries
  `name` and `title` because the pinned hosts refuse a declaration without
  `name`. If the new pinned host accepts `title` alone, remove `name` from the
  fixture and update the test that holds the fixture equal to the repository
  declaration apart from `name`.
