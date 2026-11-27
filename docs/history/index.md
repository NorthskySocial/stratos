---
audience: Maintainers and operators who meet the October contract in old notes or deployments
type: Explanation
status: legacy
---

# History

This section keeps the pages that describe the October contract. No current
build implements it, accepts it, or reproduces the evidence behind it. Read
these pages to understand an old deployment or an old note. Do not use them to
configure a current one.

The current contract is in [Spaces alignment](/architecture/spaces-alignment)
and [Supported versions](/architecture/supported-versions). The upgrade from the
October contract is in [November upgrade and rollback](/operator/november-upgrade).

## What the October contract was

| Part                             | October contract                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Space address                    | The space was a path segment of an `at://` URI, after the authority.                             |
| Credential presentation          | `Authorization: Atproto-Space`, with one signature labelled `atproto-space` over two components. |
| Delegation and attestation `aud` | The authority DID with the fragment `#atproto_space_host`.                                       |
| Upstream methods                 | `com.atproto.space.listRepos`, `notifyWrite` and the `simplespace` methods.                      |
| Reading a PDS member             | Pages waited in a staging area until the final commit verified.                                  |

## What the October evidence was

The October contract was tested against the reference implementation revision
`5b95b2f2723a2882824fbb0b819fd6aad884ef20` and a spaces PDS built from revision
`79d6307e19908f3af406838ea0e5fae42847f182`. The sandbox ran a real stack against
that PDS. Those runs are the October evidence.

No current build reproduces it. The current contract has a different address
spelling, a different credential presentation and a different sync of PDS
members. The spaces PDS images that the sandbox pins are from October and refuse
the current spelling.

## Pages

| Page                                                               | What it records                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [October writer sync contract](./october-writer-sync-contract)     | How an authority and a syncer treat writer listings and write notifications.    |
| [Credential revocation contract](./credential-revocation-contract) | The hosting responsibility behind a revocation notice, and what it leaves open. |
| [October spaces rollout](./october-spaces)                         | The operator procedure for the October credential transport.                    |
