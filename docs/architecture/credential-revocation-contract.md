# Credential revocation contract

## Problem and decision

Community membership can end while Stratos still hosts the repo. Using enrollment as proof of hosting would stop revocation notifications
precisely when retained data still needs protection. Maintainers need a hosting contract that survives departure; operators need to distinguish
that contract from access rights and deletion.

Accepted design: retain hosting responsibility independently of enrollment, using a durable hosting registry.
Hosting “ownership” means the service's responsibility for a retained repo, not a claim of legal ownership.
Community departure removes access without implicitly deleting retained data. A return requires fresh authorization;
it must not revive old credentials or automatically restore former permissions.

The standard receiver remains unimplemented. This decision settles the hosting principle, not production delivery or the complete standard role.
Departure removing access is the intended authorization policy, not a claim of immediate revocation in the current service.

There is no Stratos `com.atproto.space.notifyCredentialRevoked` receiver in the inspected baseline.
This ADR adds no endpoint, migration, revocation enforcement, fanout, or discovery entry. It is not deployment evidence.
Do not advertise `#atproto_space_host`, complete standard repo hosting, or complete standard authority support from this design.
A private `zone.stratos.*` alias would not satisfy the standard receiver contract.

Operators must continue to distinguish these controls:

| Control                                       | Current effect                                                                                    | Not evidence of                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Credential expiry                             | Bounds outstanding grants; standard grants default to 600 seconds and cannot exceed 3,600 seconds | Immediate targeted revocation                          |
| Local boundary deletion or revision           | Invalidates an old revision on Stratos endpoints                                                  | Revocation at a foreign PDS                            |
| Authority membership and ingestion generation | Stops selected repo reads and fences staged foreign work                                          | Preventing writes on a removed member's PDS            |
| Proposed targeted revocation                  | Would deny one `(space, jti)` at a receiving host                                                 | Membership removal automatically sending notifications |

See [the current spaces contract](./spaces-alignment.md) for the existing transport and custody limits.
Standard presentation signatures remain reusable for their audience until expiry. Credential IDs are not single-use nonces.

## Why hosting is separate from membership

Four responsibilities must remain distinct:

| Responsibility             | Governing question                              | Decision                                                                           |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Hosting                    | Does Stratos still host this repo?              | A durable hosting registry, independent of enrollment, establishes responsibility. |
| Access authorization       | Who may use the data now?                       | Current authorization grants access; retained data and former membership do not.   |
| Data lifecycle             | Must data be retained, deleted, or transferred? | Departure is not deletion. Explicit deletion requests require separate handling.   |
| Control and representation | Who can act for the repo or DID?                | A DID/repo need not represent one person; future groups may share control.         |

This separation supports later transfer of users' data into a space without equating community membership with the data's lifetime.
An explicit deletion request must be handled separately from departure. Re-enrollment must never resurrect completed deletion.
Transfer execution, deletion execution, and the group control model belong in separate plans; their details do not reopen this principle.

For a future shared repo, one person's departure does not necessarily delete the repo or withdraw other people's rights.
Deletion authority and scope for shared data remain a future decision. This ADR grants no collaborator the right to erase the whole repo.

### Consequences for notification eligibility

Audience eligibility means that this service still hosts the addressed account's repo. It does not mean current space membership.
The selected registry must durably prove that hosting responsibility; enrollment alone is insufficient.

| Account or repo state             | Receiver eligibility under the accepted design                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Repo still hosted by Stratos      | Eligible while the registry proves hosting, whether enrollment is active, inactive, or removed.      |
| Repo purged or transfer completed | Not eligible: Stratos's hosting responsibility has ended.                                            |
| PDS-custody enrollment            | Not evidence of Stratos hosting; the member's PDS hosts the repo.                                    |
| Pending deletion or transfer      | Receipt races and the exact handover point require follow-up lifecycle design before implementation. |

Inactive or removed enrollment does not alone end hosting responsibility. A notification cannot reactivate membership,
restore access, or discover writers. Do not use DID resolution alone, cached membership, or filesystem existence as proof of hosting.
Service enrollments likewise cannot establish hosting merely by existing; their registry treatment needs implementation design.
The service DID remains excluded as a receiver audience.

The upstream handler calls `getAccount(aud, { includeDeactivated: true, includeTakenDown: true })`.
It accepts a retained actor row despite those states, but not an account row that no longer exists.
Its revocation table is host-wide for a space, not scoped to the addressed account.

The current Stratos enrollment store cannot serve as the selected registry:
`EnrollmentStoreReader.getEnrollment` can return inactive enrollment, while `isEnrolled` requires active enrollment.
SQLite `SqliteEnrollmentStore.unenroll` deletes enrollment and boundaries.
A retained actor database alone does not establish hosting responsibility. The registry schema and migration are not defined here.

### Rejected alternatives

- Active Stratos-custody enrollment alone would drop notifications during suspension or after departure despite retained hosting.
- Deferring the hosting policy would leave the same ambiguity unresolved. Only receiver delivery and the broader standard role remain deferred.

## Receiver contract reference

The following requirements constrain a future implementation. They do not authorize an endpoint or registry migration.

### Authentication and wire contract

| Field or check        | Required restriction                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route                 | `POST /xrpc/com.atproto.space.notifyCredentialRevoked`, JSON input, empty successful response                                                         |
| Body                  | Required `space` and `credentials`; parse `space` with runtime `parseSpaceUri`, not only lexicon format validation                                    |
| IDs                   | 1–100 nonempty credential `jti` strings, not compact credential JWTs; validate the whole batch before writing; deduplicate repeated IDs               |
| Service JWT signature | Verify the authority's service-auth signing key selected under the pinned service-auth rules; never trust decoded claims alone                        |
| `iss`                 | Exact bare authority DID extracted from `space`; for this local-only proposal it must also equal configured `serviceDid`                              |
| `aud`                 | One exact bare hosted-account DID proven by the durable hosting registry; reject service DID, service fragments, arrays, foreign or unhosted accounts |
| `lxm`                 | Required and exactly `com.atproto.space.notifyCredentialRevoked`; reject missing or different values                                                  |
| JWT validity          | Validate claim types, finite timestamps, signature and expiry before authorization or persistence; retain pinned service-auth validity constraints    |
| Authorization         | Require both authority match and registry-proven hosting responsibility; a valid signature alone is insufficient                                      |
| Persistence           | Commit the complete batch durably before successful response; storage failure must not acknowledge delivery                                           |

This proposal deliberately remains local-only. Supporting notifications for foreign-authority spaces requires another explicit role and trust decision.
Do not expand credential issuer trust while adding the receiver. Do not confuse service JWT audience with credential presentation audience.
Standard credentials have no `aud`; their HTTP signature binds `Atproto-Space-Audience` to the read's account or authority DID.

The current generic verifier is not reusable unchanged:

- `stratos-service/src/infra/auth/verifier.ts` requires `payload.aud === ourDid` and permits absent `lxm`.
- `createServiceVerifier` in `infra/auth/verifiers.ts` supplies `serviceDid` and no expected method.
- `AuthVerifiers.service` returns issuer identity, but drops the verified audience and method.

Propose a separate `AuthVerifiers.credentialRevocation` entry returning a discriminated credential:
`{ type: 'credential-revocation', iss, aud, lxm }`, with `lxm` typed as the exact receiver NSID.
Validate it with a dedicated receiver verifier. Leave existing generic service auth callers unchanged.
Cryptographic primitives can be shared only after checking their key-selection and claim-validation semantics against the pin.
Do not accept OAuth, admin cookies, delegation tokens, space credentials, or an unverified body issuer as receiver authentication.

Required denial tests include validly signed wrong issuer, service-DID-only audience, foreign account, wrong method, and missing method.
Account-state tests must cover retained active, inactive, and removed enrollments, plus rejection after purge or completed transfer.
Pending lifecycle races need tests once their handover rules are specified.
Rejected input or auth must leave no revocation rows.

### Durable storage and enforcement

Use a service-level table named `revoked_space_credential`, with non-null `space`, `jti`, and `expiresAt` fields.
The primary key is `(space, jti)`. Add an expiry index for cleanup. Do not key by `jti` alone or by account.
Use the validated space string consistently; do not normalize different spaces into the same key.
Do not store credential JWTs, proof keys, or member content.

Expose a Reader lookup and a Writer extending Reader with atomic batch recording and expiry cleanup.
Keep them separate from the feature port that authorizes notifications. Inject the Reader into credential verification.
Do not use Redis or the existing replay store as authoritative revocation persistence.

For each accepted delivery, compute the retention deadline from receipt time:

```text
receiptDeadline = receiptTime + 3610 seconds
storedDeadline = max(existingDeadline, receiptDeadline)
```

The reference constants are 3,600 seconds maximum credential lifetime and five seconds skew at both ends.
Retention is at least 3,610 seconds from each receipt, even for ten-minute credentials.
Repeated IDs create one row. Retries extend or preserve retention and never shorten it.
Use an atomic database conflict update: SQLite scalar `max`, PostgreSQL `GREATEST`, with comparable UTC deadlines.
The reference helper overwrites expiry on conflict. The proposed monotonic update additionally protects concurrent or backwards-clock receipts.
Do not claim the reference already proves that stronger invariant.

Cleanup may delete only rows with deadlines at or before the cleanup cutoff.
A concurrent renewal must survive cleanup; test the actual transaction and conflict behavior on both backends.
Restart must preserve acknowledged revocations. Startup migration or storage failure must prevent enabling the receiver.
Cleanup failure can retain rows longer; it must not grant access or erase live revocations.
Operational clock rollback and multi-instance clock discipline need verification before rollout; monotonic conflict updates alone do not solve clock faults.

On every credential use, first validate the token, signature, subject, local issuer, lifetime, and presentation binding.
Then query `(validated space, validated jti)` before admitting access. Preserve active boundary and revision checks.
Return the protocol error `CredentialRevoked` for a live row. A lookup failure must deny access, not become “not revoked”.
Keep that error mapping explicit: the current verifier catch block hides credential validation errors behind generic authorization failure.
Do not query using unverified claims or cache a negative result that could hide a later revocation.
A successful read must never consume the credential ID. Revoking A must not deny B in the same space.
The same ID in another space must remain unaffected.

The accepted standard verifier already requires nonempty `jti`, local `iss`, `cnf.kid`, and a lifetime of at most 3,600 seconds.
Its `SpaceCredentialResult` does not expose `jti`, and it has no revocation dependency.
The legacy `cnf.jkt` path does not enforce the same complete claim contract.
A future implementation must explicitly decide legacy eligibility and missing-ID denial or transition before claiming coverage of every credential use.
Do not silently exempt legacy credentials, weaken their proof checks, or introduce bearer fallback.

Delegation single-use state, legacy DPoP proof replay state, and credential revocations are distinct stores and rules.
Standard HTTP signatures remain reusable. Existing boundary revision checks and ingestion generation fences remain independent controls.

## Verification requirements

### Bounded upstream probe

The `credential-revocation-contract` suite targets the actual upstream October Spaces alpha PDS at
`79d6307e19908f3af406838ea0e5fae42847f182` and the unchanged Stratos service.
The receiver, revocation helper, service-auth dispatch, and `packages/xrpc-server/src/auth.ts`
at that runner pin define these expectations. They agree with the receiver pin in the source reference below.
Source inspection is not runtime acceptance. No reviewed sandbox execution of this probe is evidenced here.

The design suite requires these exact assertions, in addition to the mandatory sandbox baseline:

| Assertion                               | Required observation                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `upstream-two-grants-read`              | Two distinct real exchanged grants read the exact seeded record.                                                      |
| `upstream-wrong-issuer-denied`          | A correctly signed authority service-fragment issuer is not the bare space authority: 403 `Forbidden`; B still reads. |
| `upstream-foreign-audience-denied`      | The authority DID is not a hosted account: 403 `Forbidden`; B still reads.                                            |
| `upstream-service-audience-denied`      | The PDS service DID is not a hosted account: 403 `Forbidden`; B still reads.                                          |
| `upstream-wrong-method-denied`          | Wrong `lxm`: 401 `BadJwtLexiconMethod`; B still reads.                                                                |
| `upstream-missing-method-denied`        | Absent `lxm`: 401 `BadJwtLexiconMethod`; B still reads.                                                               |
| `upstream-malformed-batch-denied`       | Empty, empty-ID, and 101-ID batches: 400 `InvalidRequest`; B still reads after each.                                  |
| `upstream-cross-space-isolation`        | Revoking B's ID in `other` succeeds but B still reads `general`.                                                      |
| `upstream-grant-a-revoked-b-unaffected` | Revoking A succeeds; A returns 401 `CredentialRevoked` and B still reads.                                             |
| `upstream-duplicate-idempotence`        | Repeated A IDs succeed; A remains rejected and B still reads. This does not inspect row counts or expiry.             |
| `upstream-restart-retention`            | Restarting only the disposable October Spaces alpha PDS preserves A's rejection and B's seeded-record access.         |
| `stratos-unsupported-route`             | Stratos returns 501 `MethodNotImplemented` for the standard procedure.                                                |
| `stratos-unsupported-role-unadvertised` | Stratos's DID document has no `#atproto_space_host` service.                                                          |

The probe reuses the accepted exchange, browser OAuth, HTTP presentation signatures, and disposable authority identity loader.
It signs notifications in an existing authority peer; it does not create another authority server.
The same B presentation headers are reused across reads. Grants travel between peers through pipes, not report files or command arguments.
Rejected notifications name B, so a successful subsequent B read detects accidental revocation.
Cross-space coverage checks an actual accepted revocation in a second space, not a mock predicate or altered production minting.

Wire coverage remains bounded. It does not prove retained deactivated/taken-down account behavior, purged or transferred accounts,
row-count uniqueness, monotonic expiry, or storage-failure handling. The wrong-issuer case uses a service fragment with the same valid signing key;
it does not prove acceptance or rejection of a separately controlled foreign authority.
Real cleanup-retention requires a 3,610-second wait or separately authorized disposable PDS storage instrumentation.
That future gate is unverified, not a skipped passing assertion. Unit-test fixtures validate probe assertions, not receiver enforcement.
The separate future `credential-revocation` suite must not claim these omitted cases passed.

### Production acceptance and follow-up design

The hosting policy is accepted. Receiver implementation remains deferred, and no complete standard role is established by this ADR.
Independent design reviews and a fresh reviewed-candidate sandbox baseline plus design probe remain acceptance gates.

Before production implementation, complete these follow-up designs and obtain implementation authorization:

- Define the hosting registry schema, migrations, service-account treatment, and notification races during pending deletion or transfer.
- Define transfer handover and deletion execution separately, preserving retained hosting and completed-deletion guarantees.
- Resolve the broader namespace and standard hosting role, coordinated with D01 rather than treating its historical design as accepted.
- Decide the legacy credential transition and coverage of credentials without validated IDs or bounded lifetimes.
- Confirm exact implementation scope, migration wiring, and storage/clock failure policy.

The future `credential-revocation` acceptance suite must exercise actual Stratos persistence and rejection.
It must cover authorized revocation, wrong issuer/account/method, cross-space isolation, duplicate idempotence, restart retention, and cleanup retention.
Both storage backends, lookup failure, concurrency, and changed-line mutation gates remain required.
Run build, typecheck, lint, format, full Vitest, and reviewed sandbox gates on that implementation.
A successful upstream design probe cannot satisfy them on Stratos's behalf.

Optional authority fanout needs a separate approved plan for issuance indexing, current host resolution, durable retries, and delivery policy.
Membership removal alone sends nothing under this ADR. Do not infer full standard role compliance from a receiver alone.
Shared-repo representation and deletion authority also need a separate design, not an assumption that one DID means one person.

## Implementation reference

These are proposed implementation paths. They describe the design, not existing receiver support.
New files are marked “new”. The selected hosting registry needs a separate schema and migration design; no registry fields are approved here.

| Concern                             | Proposed paths                                                                                                                                                                                                                                | Responsibility                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core feature                        | `stratos-core/src/credential-revocation/{port,domain,types,index}.ts` (new)                                                                                                                                                                   | Notification authorization and validation; no database or HTTP dependencies                                                                                 |
| Durable ports                       | `stratos-core/src/storage/credential-revocation-store.ts` (new); `stratos-core/src/storage/index.ts`; `stratos-core/src/index.ts`                                                                                                             | Reader/Writer contracts and public exports                                                                                                                  |
| Feature adapter                     | `stratos-service/src/features/credential-revocation/{adapter,handler,index}.ts` (new)                                                                                                                                                         | Dedicated auth, atomic persistence, standard procedure; no fanout worker                                                                                    |
| Durable adapters                    | `stratos-service/src/storage/sqlite/credential-revocation-store.ts` (new); `stratos-service/src/infra/storage/postgres/credential-revocation-store.ts` (new)                                                                                  | Idempotent batch upsert, live lookup, bounded cleanup                                                                                                       |
| SQLite schema and new migration     | `stratos-service/src/db/schema.ts`; `stratos-service/src/db/credential-revocation-migration.ts` (new); `stratos-service/src/db/index.ts`                                                                                                      | Declare table; invoke a new idempotent migration from `migrateServiceDb`                                                                                    |
| PostgreSQL schema and new migration | `stratos-service/src/db/pg-schema.ts`; `stratos-service/src/db/pg-credential-revocation-migration.ts` (new); `stratos-service/src/db/pg.ts`                                                                                                   | Declare twin table; invoke migration from `migrateServicePgDb`; propagate migration failures                                                                |
| Composition                         | `stratos-service/src/storage-context.ts`; `stratos-service/src/context-types.ts`; `stratos-service/src/context.ts`                                                                                                                            | Migrate before adapter creation; pass Reader to auth and Writer to feature; stop cleanup before database shutdown                                           |
| Auth                                | `stratos-service/src/infra/auth/credential-revocation-verifier.ts` (new); `stratos-service/src/infra/auth/verifiers.ts`; `stratos-service/src/infra/auth/space-credential-verifier.ts`                                                        | Dedicated issuer/account/method verifier; validated ID propagation; fail-closed lookup and error mapping                                                    |
| Registration                        | `stratos-service/src/api/handlers.ts`; `stratos-service/src/features/index.ts`                                                                                                                                                                | Register only in a separately authorized implementation; no DID role publication                                                                            |
| Lexicon                             | `lexicons/com/atproto/space/notifyCredentialRevoked.json` (new); `stratos-core/src/lexicons/index.ts`                                                                                                                                         | Pin the standard wire schema; retain runtime space validation                                                                                               |
| Generated bindings                  | `stratos-client/scripts/gen-lexicons.mjs`; `stratos-client/src/lexicons.gen.ts`                                                                                                                                                               | The current generator selects only `zone/stratos` roots; explicitly approve standard schema inclusion before regeneration; do not hand-edit generated files |
| Tests                               | `stratos-core/tests/credential-revocation.test.ts` (new); `stratos-service/tests/credential-revocation.test.ts` (new); `stratos-service/tests/space-credential-acceptance.test.ts`; `stratos-service/tests/space-credential-verifier.test.ts` | Auth matrix, real SQLite/PostgreSQL upgrades, concurrent updates, cleanup, restart, credential A/B isolation, legacy transition                             |
| Public contract                     | `stratos-client/README.md`; `docs/client/api-reference.md`; `docs/architecture/spaces-alignment.md`                                                                                                                                           | Document shipped endpoint and limitations only when implemented                                                                                             |

The inspected service does not use a numbered migration journal for these service tables.
`createStorageContext` calls `migrateServicePgDb(pgDb)` or `migrateServiceDb(db)` before constructing stores.
Register new migration functions in those entry points. Do not rewrite applied migration statements or use actor-repo migrations.
The table belongs in the shared service database, not each actor database or the Feedgen projection.
Use fresh-database and existing-database upgrade tests, rerun initialization, then reopen the same database and verify retained rejection.
Use the existing PostgreSQL container patterns; an unavailable database is a missing verification gate, not passing coverage.

## Source reference

The inspected local baseline is `59d11aaa7254ae60439a60b21f781a9e41301202`, including the accepted October transport changes.
The following pins describe source contracts, not running image identities.

| Source                                 | Pin and inspected paths                                                                                                                                                    | Relevant finding                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ATProto reference implementation       | `5b95b2f2723a2882824fbb0b819fd6aad884ef20`: `lexicons/com/atproto/space/notifyCredentialRevoked.json`; `packages/pds/src/api/com/atproto/space/notifyCredentialRevoked.ts` | Procedure uses authority service auth addressed to a hosted repo DID                                                               |
| Reference persistence                  | Same pin: `packages/pds/src/account-manager/helpers/revoked-space-credential.ts`; `packages/pds/src/account-manager/db/schema/revoked-space-credential.ts`                 | Service-level `(space, jti)` key, receipt-based expiry, durable lookup and cleanup                                                 |
| Reference auth and account eligibility | Same pin: `packages/pds/src/auth-verifier.ts`; `packages/pds/src/account-manager/helpers/account.ts`; `packages/space/src/credential.ts`                                   | Handler checks issuer and hosted account; includes deactivated and taken-down rows; credential lookup follows signature validation |
| Permissioned-data proposal             | `0c9c2e88ba385809fc9ecba92f362389d9338e16`: `0016-permissioned-data/README.md`, “Credential expiration and revocation”                                                     | Authority fanout is optional; receiving repo hosts must reject revoked IDs and retain them for at least 60 minutes                 |
| Historical D01 design                  | Local historical commit `fdb11e26aa8401d81f14cbfd4e07e708b8e5c1be`: `docs/architecture/standard-space-authority.md`                                                        | Mixed custody does not establish the complete standard role                                                                        |

D01 is historical design evidence only. That commit is not an ancestor of the accepted baseline.
No unmerged D01 production code is imported. Reconcile its older protocol pins before using any proposed adapter.
Delegation replay state and the independent DPoP design do not establish revocation support.
