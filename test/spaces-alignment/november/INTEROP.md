# Interop checklist

For the person who runs the sandbox suites. It covers what to run today, and
what to run against the published PDS that accepts the `at:space/` record
and space spelling. The November 26 probe and its URI receipt record a successful
dotted-authority journey; other acceptance journeys remain outstanding.

Every runner command below (`pnpm exec tsx test/spaces-alignment/run-sandbox.ts`)
runs from the repository root, needs rootless Docker, a clean checkout at a
committed SHA, a report directory that does not exist, and either the
two-review receipt (`test/spaces-alignment/README.md`) or GitHub Actions with
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

The baseline is a diagnostic here, never acceptance. The earlier pinned host
refused the new spelling; the November 26 published-host probe succeeded for
the dotted authority. Run the baseline to measure the selected candidate. The driver prints each assertion name when
the step that proves it ends, and `failure.json` lists those names under
`assertionsReached`. The steps run in this order: `browser-oauth`,
`pds-custody`, `publication-feed`, `space-lexicon`, `pds-space-grant`,
`public-private-blob-denied`, `authenticated-space-blob`, `stratos-custody`,
`unrelated-boundary-denied`, `boundary-isolation`.

- If a step fails, read `assertionsReached` to identify the completed steps;
  later steps are not evidence of acceptance.

## Health during a write

The October manifest still records `staging-limits:service-responsive` as
uncovered by an October carrier. The November fixture for
`health-answers-while-a-sync-writes` makes three loopback HTTP calls while a
verified replacement holds the write transaction open. Timing in the
standalone sandbox process remains open.

## 2. Repeating the published-host checks

These steps describe how to repeat the checks. Stop at the first failure and
keep its output. The published PDS image used on November 26 has digest
`sha256:7edcfdfe1c6e2638de00b1d718d8702bce321389595711aab9f8008b3e269350`
and reports source revision `1f510f8e36a973f6fd055da349b586918805ae66`.
The checked-in URI probe records an exact dotted-authority create and read on
that image. The reference build uses that source revision; the migration guide
has its own release anchor in the manifest. Verify method paths again if either
pin changes.

1. **Build the reference source.** The manifest pins a reference source and
   build inputs. To repeat the source build locally as the runner does
   (`buildAlphaPds` in `test/spaces-alignment/build-alpha-pds.ts`), obtain
   `<the daemon's socket URL>` from
   `docker context inspect rootless --format '{{.Endpoints.docker.Host}}'`.
   These example build commands have not been verified as a reproduction of the
   published image.

   ```sh
   git clone https://github.com/bluesky-social/atproto.git <upstream checkout>
   git -C <upstream checkout> checkout --detach <revision>
   grep -E '^FROM ' <upstream checkout>/Dockerfile
   docker pull <each image a FROM line names that is not a stage name>
   export DOCKER_HOST=<the daemon's socket URL>
   DOCKER_CONFIG="$(mktemp -d)" docker build --progress=plain \
     --file <upstream checkout>/Dockerfile \
     --label org.opencontainers.image.revision=<revision> \
     --iidfile pds-image.id --tag stratos-reference-pds:probe <upstream checkout>
   cat pds-image.id
   ```

   The runner differs from a plain `docker build` in two ways, and either can
   change the image ID. It pulls every base image a `FROM` line names before it
   builds, so a newer image under the same tag replaces a cached one. It builds
   with `DOCKER_CONFIG` set to a new empty directory, so none of your own
   builder, proxy or credential settings apply. The commands above do both.
   With an empty `DOCKER_CONFIG` the CLI cannot read your Docker contexts, so
   name the rootless daemon with `DOCKER_HOST`. The upstream `Dockerfile` needs
   BuildKit, so the `buildx` plugin must be installed where the CLI finds it
   without your config. At the reference revision the only base image is
   `node:24.22.2-alpine3.24`, and the last stage, which `docker build` builds by
   default, is `pds`.

   The last line prints `sha256:` and 64 hex digits. That is the local image ID
   that `docker build --iidfile` writes, not a registry digest. Record this as the locally built image ID. It is distinct from the published registry digest in `uriProbe.imageDigest`; the November 26 probe used the published image, not this build.

2. **Fill the manifest** `test/spaces-alignment/november/sources.json`:
   `reference.revision` and `reference.releaseAnchor` (neither may be a revision
   on `legacyUriOnly`), each package's `version`, `integrity` and
   `tarballSha256`, and `referenceHost.sha256` with the SHA-256 of `Dockerfile`
   and `pnpm-lock.yaml` at that revision. The runner refuses to build the
   reference host while those two hashes are empty or the revision is on the
   legacy-only list or is the revision the October file pins. The pinned build inputs and published package metadata were verified for the November 26 release. The release package metadata is separate from the installed dependency selections. The following commands can repeat those checks.

   ```sh
   git -C <upstream checkout> show <revision>:Dockerfile | sha256sum
   git -C <upstream checkout> show <revision>:pnpm-lock.yaml | sha256sum
   npm view <package>@<version> dist.integrity
   npm pack <package>@<version> --pack-destination <scratch directory>
   sha256sum <scratch directory>/*.tgz
   ```

3. **Probe.** Start the image on its own network with a PLC directory, ask it to
   parse a space URI in the new spelling, then make one record and one
   credential in that spelling. Use a local PLC directory, never the public one.
   Not verified: none of these commands has been run, and the PDS settings
   follow `templates/reference-pds.yaml`.

   Start the PLC directory. The upstream repository starts one in its
   development environment: `TestPlc` in `packages/dev-env/src/plc.ts`, with an
   in-memory database, on port 2582 in `packages/dev-env/src/bin.ts`. Build the
   workspace first, in the same base image, as the `Dockerfile` build stages
   do. This writes `node_modules` and build output into `<upstream checkout>`,
   so do it after the image build of step 1.

   ```sh
   docker network create stratos-reference-probe
   docker run --rm --volume <upstream checkout>:/src --workdir /src \
     node:24.22.2-alpine3.24 \
     sh -ec 'corepack enable && pnpm install --frozen-lockfile && pnpm run prebuild && pnpm run build'
   docker run --rm --detach --name stratos-reference-plc \
     --network stratos-reference-probe \
     --volume <upstream checkout>:/src:ro --workdir /src/packages/dev-env \
     node:24.22.2-alpine3.24 \
     node --input-type=module -e "import { TestPlc } from './dist/plc.js'; await TestPlc.create({ port: 2582 })"
   ```

   Start the PDS on the same network. `<random hex>` is the output of
   `openssl rand -hex 16`, `<64 hex>` the output of `openssl rand -hex 32`, and
   `<random text>` any password you choose for the admin account.

   ```sh
   docker run --rm --detach --name stratos-reference-pds-probe \
     --network stratos-reference-probe --publish 127.0.0.1:2583:3000 \
     --env PDS_HOSTNAME=localhost --env PDS_DEV_MODE=true \
     --env PDS_JWT_SECRET=<random hex> --env PDS_ADMIN_PASSWORD=<random text> \
     --env PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=<64 hex> \
     --env PDS_DID_PLC_URL=http://stratos-reference-plc:2582 \
     --env PDS_DATA_DIRECTORY=/app/data \
     --env PDS_BLOBSTORE_DISK_LOCATION=/app/data/blocks \
     --env PDS_INVITE_REQUIRED=false --env PDS_CRAWLERS= \
     "$(cat pds-image.id)"
   ```

   Ask it to parse a space URI. At the reference revision the host validates
   query parameters before it checks authentication
   (`packages/xrpc-server/src/server.ts`), so the request needs no account.
   Parameters from `lexicons/com/atproto/space/getRecord.json`.

   ```sh
   curl --silent --write-out '\n%{http_code}\n' \
     'http://127.0.0.1:2583/xrpc/com.atproto.space.getRecord?space=at:space/did:web:stratos.example/zone.stratos.space.feed/general&repo=did:plc:spikespiegelbebopcrewabc&collection=zone.stratos.feed.post&rkey=bebop'
   ```

   A 401 answer means the host parsed the space URI and asked for
   authentication. A 400 `InvalidRequest` answer about `space` means it refuses
   the spelling: stop here.

   Make an account and a session. `<password>` is one you choose. With
   `PDS_HOSTNAME=localhost` the host's handle domain is `.test`
   (`packages/pds/src/config/config.ts`). Parameters from
   `lexicons/com/atproto/server/createAccount.json` and
   `lexicons/com/atproto/server/createSession.json`. The lexicon requires only
   `handle`; whether this host also requires `email` and `password` is not
   established from it, so both are sent.

   ```sh
   curl --silent --request POST http://127.0.0.1:2583/xrpc/com.atproto.server.createAccount \
     --header 'content-type: application/json' \
     --data '{"handle":"spike.test","email":"spike@bebop.test","password":"<password>"}'
   curl --silent --request POST http://127.0.0.1:2583/xrpc/com.atproto.server.createSession \
     --header 'content-type: application/json' \
     --data '{"identifier":"spike.test","password":"<password>"}'
   ```

   From the session answer, `<access token>` is `accessJwt` and `<did>` is
   `did`. Create a personal space with the account as its authority, then a
   record in it, with `validate` false so the host does not try to validate a
   Stratos record type. `<space>` is the `space` that `createSpace` returns.
   Parameters from `lexicons/com/atproto/space/createSpace.json`,
   `lexicons/com/atproto/personalspace/policy.json` and
   `lexicons/com/atproto/space/createRecord.json`.

   ```sh
   curl --silent --request POST http://127.0.0.1:2583/xrpc/com.atproto.space.createSpace \
     --header 'content-type: application/json' \
     --header 'authorization: Bearer <access token>' \
     --data '{"spaceType":"zone.stratos.space.feed","skey":"bebop","policy":{"$type":"com.atproto.personalspace.policy"}}'
   curl --silent --request POST http://127.0.0.1:2583/xrpc/com.atproto.space.createRecord \
     --header 'content-type: application/json' \
     --header 'authorization: Bearer <access token>' \
     --data '{"space":"<space>","repo":"<did>","collection":"zone.stratos.feed.post","validate":false,"record":{"$type":"zone.stratos.feed.post","text":"See you space cowboy","createdAt":"2026-11-21T00:00:00.000Z"}}'
   ```

   Read the record back at the URI `createRecord` returns. `<rkey>` is the last
   part of that URI. Parameters from
   `lexicons/com/atproto/space/getRecord.json`.

   ```sh
   curl --silent --get http://127.0.0.1:2583/xrpc/com.atproto.space.getRecord \
     --header 'authorization: Bearer <access token>' \
     --data-urlencode 'space=<space>' --data-urlencode 'repo=<did>' \
     --data-urlencode 'collection=zone.stratos.feed.post' \
     --data-urlencode 'rkey=<rkey>'
   ```

   Get a delegation token, make a P-256 key for the credential, and exchange
   both for a credential. `<token>` is the `token` that `getDelegationToken`
   returns and `<credential key>` the `did:key` the second command prints.
   `authorizeSpaceSync` takes no authentication header: its handler declares
   none (`packages/pds/src/api/com/atproto/space/authorizeSpaceSync.ts`), and
   for a personal space it accepts the authority's own delegation token.
   Parameters from `lexicons/com/atproto/space/getDelegationToken.json` and
   `lexicons/com/atproto/space/authorizeSpaceSync.json`; the key comes from
   `P256Keypair` in `packages/crypto`.

   ```sh
   curl --silent --get http://127.0.0.1:2583/xrpc/com.atproto.space.getDelegationToken \
     --header 'authorization: Bearer <access token>' \
     --data-urlencode 'space=<space>'
   docker run --rm --volume <upstream checkout>:/src:ro --workdir /src/packages/crypto \
     node:24.22.2-alpine3.24 \
     node --input-type=module -e "import { P256Keypair } from './dist/index.js'; console.log((await P256Keypair.create()).did())"
   curl --silent --request POST http://127.0.0.1:2583/xrpc/com.atproto.space.authorizeSpaceSync \
     --header 'content-type: application/json' \
     --data '{"space":"<space>","credentialKey":"<credential key>","delegationToken":"<token>"}'
   node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1], 'base64url')).sub)" '<credential>'
   ```

   The checked-in `uri-probe-receipt.json` is a projection of the November 26
   run against the published image. Its source receipt SHA-256 is
   `14df3afee935aba074f5ce9ab27519a46a08bbb929ec089c56d88f931178f7c6`; the
   source receipt also records the migration rehearsal and its feed-count
   failure. Readiness checks the receipt hash, published image
   digest, exact configured dotted authority and record URI, credential
   subject, and matching create/read CID. It does not claim that a locally built
   image has the published image digest, or that the release SDKs are installed.
   A passing URI probe does not close that failure.

4. **Run the upstream migrations on a disposable database.** The PDS applies
   its own migrations when it starts. Start the image of step 1 once against an
   empty data directory and once against a copy of a data directory an earlier
   PDS build wrote, with the settings of step 3, on the same network, and with
   another host port. Not verified: these commands have not been run.

   ```sh
   docker run --rm --detach --name stratos-reference-pds-migrate \
     --network stratos-reference-probe --publish 127.0.0.1:2584:3000 \
     --volume <empty directory>:/app/data \
     <the --env settings of step 3> "$(cat pds-image.id)"
   curl --silent --write-out '\n%{http_code}\n' http://127.0.0.1:2584/xrpc/_health
   docker logs stratos-reference-pds-migrate
   docker stop stratos-reference-pds-migrate
   ```

   Then run the same four commands with `<copy of a kept data directory>` in
   place of `<empty directory>`. A 200 answer from `_health` means the PDS
   started on that database; keep the logs either way. Under rootless Docker
   the image's `node` user may not be able to write a directory you created; if
   the PDS cannot write `/app/data`, add `--user 0:0`. The November 26
   rehearsal used the published image against copies of older stores and
   recorded account migration 013 and actor migrations 010 and 011. It also
   found a downstream feed projection failure; see the source receipt cited by
   `uri-probe-receipt.json`. Repeat the rehearsal on disposable copies for the
   candidate under review. When this step ends, stop the PLC and probe PDS and
   remove the network:

   ```sh
   docker stop stratos-reference-pds-probe stratos-reference-plc
   docker network rm stratos-reference-probe
   ```

5. **Check the sandbox pin and declaration fixture.** The disposable sandbox
   overrides `pds-space1` with the published digest recorded above, and the
   Deno suite pins the same published image. The reference PDS is built
   separately from the manifest source. If either pin changes, repeat the URI
   probe and migration rehearsal, and check whether the declaration fixture's
   `name` and `title` fields remain compatible with that host.

6. **Commit, and get the review receipt for that commit.** Steps 2, 3 and 5
   edit the checkout, and the runner needs a clean checkout at a committed SHA and a
   receipt (or `--ci-evidence`) for that same SHA
   (`test/spaces-alignment/README.md`).

7. **Know how the runner identifies each host.** Suites that need a reference
   host build it from the pinned upstream root `Dockerfile`; the build validates
   the manifest readiness and the Dockerfile and lockfile hashes. The runner
   records that build's local image ID and checks the reference container against
   it. The member PDS uses the published image digest independently; the runner
   checks its running local image ID against its configured image. For
   `november-interop`, `--pds-image-digest` must equal the digest in the URI
   probe and the pinned published member image. It is not compared with the
   separate source build's local image ID. The reference service definition is
   `test/spaces-alignment/templates/reference-pds.yaml`.

8. **Run the baseline.** All ten assertions must pass; the receipt is
   acceptance only for the baseline. The November 26 verification records a successful baseline against the published image; a new candidate still needs its own run.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite baseline \
  --review-receipt <receipt file> \
  --report-dir <new directory>
```

9. **Run each other suite**, one run each, each with a new report directory and
   fresh accounts. Save every `receipt.json` and `failure.json`. Not verified:
   no run of any of them is recorded.

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

10. **Run `november-interop`.** It starts only with `--pds-image-digest` naming
    the published member image, and only when the manifest is ready and its probe
    records the same digest. If journeys remain open, the command exits nonzero
    and writes `failure.json`. Read `novemberInterop.outstanding` for the
    remaining IDs, `failedGroups` for groups that stopped early, and `evidence`
    for the observation and artifact for each reported journey. For a failed
    child command, `groupProgress` lists its completed steps and
    `failedGroupExitCodes` lists numeric exit codes. An evidence row
    with `remainingHostQuestion` is still open. The runner continues with
    independent groups after a group fails.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite november-interop \
  --review-receipt <receipt file> \
  --report-dir <new directory> \
  --pds-image-digest sha256:<digest>
```

### Positive PDS-custody journey

`november-positive` independently exercises OAuth create and read, a Stratos-bound
credential read with the published SDK record-MAC verifier, feed delivery, and
OAuth delete. Its receipt is not full interop acceptance. The dated URI probe
above records a prior successful published-host run; a new runner receipt records
only what that run actually executes.

```sh
pnpm exec tsx test/spaces-alignment/run-sandbox.ts \
  --sandbox-dir <sandbox checkout> \
  --source "$(git rev-parse --show-toplevel)" \
  --suite november-positive \
  --pds-image-digest <published image digest> \
  --review-receipt <receipt file> \
  --report-dir <new directory>
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
- Observed: The November 26 published PDS returned the dotted-authority URI and a matching credential subject; see `uri-probe-receipt.json`.
- Command: Run `november-positive` for the positive journey; the complete suite still requires all journeys.
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
- Command: Run `november-interop` for the webapp and its isolated browser request recorder.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 7. `other-author-snapshot-without-direct-request`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A viewer sees another author post only as a labeled feed snapshot, and no request goes from the viewer to that author PDS.
- Expected: The feed generator serves from its own projection.
- Unknown: Needs a request log from the host or the sandbox proxy to show no direct request; the baseline does not record one.
- Command: Run `november-interop` for the webapp and its isolated browser request recorder.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 8. `custom-mint-reads-from-reference-pds`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A credential minted by Stratos, as space authority, reads a member's record from the reference host.
- Expected: The credential names the authority as issuer and the space as subject, binds the presentation key in cnf.kid, carries no aud, and is signed with the authority key; the #atproto_pds audience is on the delegation it was exchanged for. The receiver checks the signature against the authority DID document and calls no Stratos method.
- Observed: The November 26 published PDS accepted a Stratos-minted credential and returned a record with a verified MAC; see `uri-probe-receipt.json`.
- Command: Run `standard-credential-transport` (command below); it carries this journey in a ported form, as do `rust-production-interop`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 9. `upstream-standard-mint-control`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: The host's own standard credential exchange works in the same stack, so a failure of the custom mint is not a stack fault.
- Expected: For a space whose authority is the host, its com.atproto.space.authorizeSpaceSync returns a credential for a delegation token and a P-256 credentialKey. The November control uses a separate personal space and compares the credential issuer and subject and the retrieved record CID.
- Unknown: The host exchange route at the pinned build.
- Command: Run `november-interop` for the published PDS personal-space mint and verified read. Use the per-group progress to locate a host failure.
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
- Unknown: Whether the host honours removal sooner than expiry. The host takes com.atproto.space.notifyCredentialsRevoked from the space authority, by credential id, but Stratos never sends it.
- Command: Run `standard-credential-transport` (command below); it carries this journey in a ported form, as do `rust-production-interop` and `credential-lifetime`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 14. `non-member-forged-boundary-write-never-indexed`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: A non-member's write with a forged boundary lands in the host repo and is never indexed or served by the feed generator.
- Expected: The feed generator reads the boundary from Stratos membership state, never from the record.
- Unknown: Whether the host lets a non-member write at all. That is the next journey.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 15. `host-does-not-authorize-write-against-authority`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: Whether the host checks the space authority or membership on a write: a second account writes into a space whose authority cannot be resolved.
- Expected: The write should succeed: at the November reference revision, com.atproto.space.createRecord checks only the caller's own repo, its OAuth grant and that the collection is not a policy record before it commits (packages/pds/src/api/com/atproto/space/createRecord.ts). Stratos treats any record in a member repo as an unverified claim until its own membership and boundary state agree.
- Unknown: What a pinned November host does. An August probe of an earlier alpha build reported that such a write succeeded; the repository keeps its commit message, not its output or the build it ran against, and its first version did not ensure the writer was a second, unrelated account.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 16. `post-uri-and-text-in-real-feed-response`

- Closes: Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.
- Proves: The exact new post URI and text appear in a real feed HTTP response, not only on a rendered page.
- Expected: The feed response carries the URI the write returned: at:space/ for a PDS-custody post, at:// for a Stratos-custody post.
- Observed: The November 26 published host returned the exact dotted-authority URI recorded in `uri-probe-receipt.json`.
- Command: Run `baseline` (command below); it carries this journey in a ported form, as do `ordinary-custody`.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 17. `nonterminal-mac-tamper-never-promoted`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A page with a corrupted commit MAC that is not the terminal page promotes nothing.
- Expected: The feed generator promotes only after every page MAC and the terminal set hash verify.
- Unknown: Needs a way to corrupt one page in transit, for example a proxy in front of the host.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 18. `terminal-set-hash-mismatch-never-promoted`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A terminal page whose set hash does not match the records applied promotes nothing.
- Expected: The set hash of the whole repo, kept from the stored base and updated by each op, must equal the commit's data before anything is promoted.
- Unknown: As above.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 19. `non-post-record-contributes-to-integrity`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A record of a collection the feed does not serve still counts in the integrity hash of the repo.
- Expected: Every record of the repo is hashed, whatever its collection.
- Unknown: How the host orders and pages such records.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 20. `full-page-then-empty-terminal`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A repo that exactly fills a page is followed by an empty terminal page and verifies.
- Expected: A page without a cursor ends the poll, whatever its ops, and only that page's commit is proven and promoted; a page with a cursor is never the last.
- Unknown: Whether the host sends a cursor after a full page and then an empty page, or ends on the full page.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 21. `expired-cursor-replaced-by-verified-star`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: When the host refuses an expired cursor, the feed generator reads a whole-repo archive and replaces the stored state only after it verifies.
- Expected: The archive is read to the end and verified before any stored row changes.
- Unknown: How long the host keeps a cursor and the archive error words.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 22. `crash-restart-reaches-verified-terminal-revision`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: Stopping the feed generator mid-sync and starting it again ends at the verified terminal revision with nothing half-applied.
- Expected: Nothing is promoted until verification ends; a restart resyncs.
- Unknown: The restart timing against a real host.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 23. `host-and-kem-key-rotation`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: After a member moves host or rotates the key the host uses for the encrypted commit data, the next poll refreshes the key once and verifies.
- Expected: One refresh and one new request after a failure with the old key; a stored host other than the target starts a replacement.
- Unknown: How the host publishes the rotated key.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 24. `membership-revoked-mid-poll`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A member removed while a poll is running promotes nothing, other members are untouched, a member added again starts with a fresh generation, and a restart keeps the removal.
- Expected: Each store write checks the generation, so a stale poll changes nothing.
- Unknown: Timing against a real host.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 25. `health-answers-while-a-sync-writes`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: While a poll or a whole-repo replacement of a large member repo writes to the store, the feed generator answers /health within two seconds.
- Expected: The health handler reads the readiness gate and scheduler status independently of the store transaction.
- Unknown: How long a store write takes on a large real repo, and whether /health waits for it.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 26. `malformed-or-truncated-archive-refused`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A malformed or truncated whole-repo archive is refused and changes nothing.
- Expected: An archive over a limit fails as a unit with nothing written.
- Unknown: What the host sends when its own read fails midway.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 27. `suspension-and-offline-are-not-deletion`

- Closes: The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.
- Proves: A suspended or unreachable host leaves the member projection in place and does not delete it.
- Expected: A failed target is counted as a failure.
- Unknown: The host error codes for suspension and takedown.
- Command: Run `november-interop` for fixture evidence. The pinned-host observation remains open.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

### 28. `mixed-cache-migration-preserves-custody`

- Closes: The cache migration keeps custody data, the PDS projection is rebuilt from a verified sync, and a rollback pairs matching versions.
- Proves: A cache that held both custodies before the upgrade keeps the Stratos-custody rows and rebuilds the PDS-custody projection by a verified sync.
- Expected: The migration purges every space row and keeps everything else byte for byte; some of its tests run on encrypted file stores.
- Unknown: A real kept database and the upstream migrations on a disposable database have not been rehearsed.
- Command: No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.
- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.

## Open questions for a November host

A host answers each of these once; nobody has the answer for the new build.
August probes of an earlier upstream alpha build reported answers to the first
two. The repository keeps their commit messages, not their output or the build
they ran against.

- Does a host check the space authority or membership on a write? A second
  account writes into a space whose authority cannot be resolved. The August
  probe reported that the write succeeded; its first version did not ensure
  the writer was a second, unrelated account, and no run after the fix is
  recorded. At the November reference revision,
  `com.atproto.space.createRecord` checks only the caller's own repo, its OAuth
  grant and that the collection is not a policy record before it commits.
  Stratos treats any record in a member repo as an unverified claim until its
  own membership and boundary state agree (journeys
  `host-does-not-authorize-write-against-authority` and
  `non-member-forged-boundary-write-never-indexed`).
- Does a host accept a credential that a foreign authority minted, verified
  against the authority DID document with no call back to Stratos (journey
  `custom-mint-reads-from-reference-pds`)? The August probe reported that the
  alpha build did.
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
- Does a host deliver `com.atproto.space.notifyRepoUpdate` to Stratos after a
  member writes? Stratos's DID document offers `#atproto_pds` at the Stratos
  origin, and the in-process service accepts the notice with either audience
  the reference PDS may use. No journey drives a real host's notice yet, and
  Stratos depends on none: the feed generator polls the member's PDS.
