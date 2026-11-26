/**
 * The journeys a person walks the day a host accepts the new space spelling.
 * Each one names the acceptance row it closes. Nothing here has run against a
 * host: `expected` is what the repository's own tests lead us to predict and
 * `unknown` is what only a host can show.
 */

import { syncFixtures } from './sync-fixtures.js'

export const ACCEPTANCE_ROWS = {
  'target-artifact':
    'A pinned upstream build accepts the new space spelling: a record created on it comes back in that spelling, and a credential for it names the same space.',
  'mixed-custody-privacy':
    'Real hosts and the real service keep every record inside the boundaries its viewer shares, for both custodies.',
  'verified-sync-recovery':
    'The feed generator promotes only fully verified repo state from a real host, and recovers from gaps, key rotation and restarts without serving unverified records.',
  'migration-rollback':
    'The cache migration keeps custody data, the PDS projection is rebuilt from a verified sync, and a rollback pairs matching versions.',
} as const

export type AcceptanceRow = keyof typeof ACCEPTANCE_ROWS

export interface Journey {
  id: string
  acceptanceRow: AcceptanceRow
  proves: string
  expected: string
  unknown: string
  observed?: string
  /** Runner suites that carry this journey in a ported form; empty when no driver exists yet. */
  carriedBy: readonly string[]
}

export const JOURNEYS: readonly Journey[] = [
  {
    id: 'canonical-uri-at-each-boundary',
    acceptanceRow: 'target-artifact',
    proves:
      'Create a record on the reference host, read back the URI it returns, read the record at that URI, and mint a credential: the URI, the record address and the credential subject all use the at:space/ spelling.',
    expected:
      'Stratos recognises only the at:space/ spelling and converts nothing, so a host that returns the new spelling should round-trip.',
    unknown:
      'Whether the build you pinned returns the new spelling from create and read. Nothing has been observed from any host.',
    observed:
      'The November 26 published PDS returned the dotted-authority URI and a matching credential subject; see `uri-probe-receipt.json`.',
    carriedBy: [],
  },
  {
    id: 'ordinary-custody-create-feed-delete',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A Stratos-custody member on an ordinary PDS posts through the service, the post appears in the feed from the Rust feed generator, a member of another boundary is denied, and the delete removes it.',
    expected:
      'Should pass: the journey touches no space URI and no credential from the spaces PDS.',
    unknown:
      'The suite has never run; the first run may show a stack or driver fault.',
    carriedBy: ['ordinary-custody'],
  },
  {
    id: 'two-authors-on-one-host',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      "Two PDS-custody members who share one reference host each have their own seeded record read with one Stratos credential presented to their own repo, and a presentation addressed to one member is refused for the other member's repo.",
    expected:
      'Each read is addressed to the author, never to the authority. The credential names the space, not a member; the presentation names the repo it is for, and the host refuses it for any other repo.',
    unknown:
      'How the host answers a credential presentation in the tagged signature form.',
    carriedBy: ['standard-credential-transport', 'rust-production-interop'],
  },
  {
    id: 'authors-on-separate-hosts',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'Two PDS-custody members on two different hosts are both ingested and served in one boundary feed, each read from its own host.',
    expected:
      'Host discovery follows the authority override, then the #atproto_pds entry of the member DID document.',
    unknown:
      'The template provides one reference host; a second host needs its own service and routes.',
    carriedBy: [],
  },
  {
    id: 'schema-resolution-and-explicit-grants',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'The host resolves the space type declaration during OAuth, grants the space scope, and accepts a PDS-custody write made under that grant.',
    expected:
      'The sandbox declaration fixture carries name and title and the three collections of the repository declaration, which carries title only.',
    unknown:
      'Whether the host in use still requires name, how it answers the space scope string, and whether it refuses a write without the grant: no driver writes without it.',
    carriedBy: ['baseline'],
  },
  {
    id: 'inspector-reads-own-record-through-oauth',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'The webapp inspector reads the signed-in member own PDS-custody record with that member OAuth grant.',
    expected:
      "The inspector classifies the address, then sends exactly one com.atproto.space.getRecord to the signed-in member's own PDS for their own repo, and no request for another author's space record or for an address it refuses.",
    unknown: 'The host response to the OAuth-bound read.',
    carriedBy: [],
  },
  {
    id: 'other-author-snapshot-without-direct-request',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A viewer sees another author post only as a labeled feed snapshot, and no request goes from the viewer to that author PDS.',
    expected: 'The feed generator serves from its own projection.',
    unknown:
      'Needs a request log from the host or the sandbox proxy to show no direct request; the baseline does not record one.',
    carriedBy: [],
  },
  {
    id: 'custom-mint-reads-from-reference-pds',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      "A credential minted by Stratos, as space authority, reads a member's record from the reference host.",
    expected:
      'The credential names the authority as issuer and the space as subject, binds the presentation key in cnf.kid, carries no aud, and is signed with the authority key; the #atproto_pds audience is on the delegation it was exchanged for. The receiver checks the signature against the authority DID document and calls no Stratos method.',
    unknown:
      'Whether a November host accepts a credential minted by a foreign authority. An August probe of an earlier alpha build reported that it did; the repository keeps its commit message, not its output.',
    observed:
      'The November 26 published PDS accepted a Stratos-minted credential and returned a record with a verified MAC; see `uri-probe-receipt.json`.',
    carriedBy: ['standard-credential-transport', 'rust-production-interop'],
  },
  {
    id: 'upstream-standard-mint-control',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      "The host's own standard credential exchange works in the same stack, so a failure of the custom mint is not a stack fault.",
    expected:
      'For a space whose authority is the host, its com.atproto.space.authorizeSpaceSync returns a credential for a delegation token and a P-256 credentialKey. The November control uses a separate personal space and compares the credential issuer and subject and the retrieved record CID.',
    unknown: 'The host exchange route at the pinned build.',
    carriedBy: [],
  },
  {
    id: 'wrong-key-and-wrong-owner-denied',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      "A presentation signed with the wrong key, and a presentation addressed to one owner sent to another owner's repo, are refused by the reference host.",
    expected: 'Both are refused with an authentication error, never a record.',
    unknown: 'The host error words.',
    carriedBy: ['standard-credential-transport', 'rust-production-interop'],
  },
  {
    id: 'current-delegation-and-client-attestation-accepted',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A delegation with the #atproto_pds audience is accepted by the custom mint, and an allow-listed client attestation is accepted.',
    expected:
      'The service verifier accepts the current audience and the allow-listed attestation.',
    unknown:
      'How the host issues the delegation for an OAuth session. No driver presents a client attestation, so no suite carries this journey; delegation-transport and credential-lifetime perform the delegation half only.',
    carriedBy: [],
  },
  {
    id: 'invalid-jwt-signature-refused-by-receiver',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A credential whose JWT signature is invalid is refused by the receiving verifier on the reference host.',
    expected: 'Refused before any record is read.',
    unknown: 'The host response.',
    carriedBy: ['standard-credential-transport'],
  },
  {
    id: 'renewal-and-revoked-member-denied',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A credential renews with a fresh key, and after the member is removed a renewal is denied while a credential already issued still reads until it expires.',
    expected:
      'Renewal after removal is denied by Stratos; a credential already issued lapses at its expiry.',
    unknown:
      'Whether the host honours removal sooner than expiry. The host takes com.atproto.space.notifyCredentialsRevoked from the space authority, by credential id, but Stratos never sends it.',
    carriedBy: [
      'standard-credential-transport',
      'rust-production-interop',
      'credential-lifetime',
    ],
  },
  {
    id: 'non-member-forged-boundary-write-never-indexed',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      "A non-member's write with a forged boundary lands in the host repo and is never indexed or served by the feed generator.",
    expected:
      'The feed generator reads the boundary from Stratos membership state, never from the record.',
    unknown:
      'Whether the host lets a non-member write at all. That is the next journey.',
    carriedBy: [],
  },
  {
    id: 'host-does-not-authorize-write-against-authority',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'Whether the host checks the space authority or membership on a write: a second account writes into a space whose authority cannot be resolved.',
    expected:
      "The write should succeed: at the November reference revision, com.atproto.space.createRecord checks only the caller's own repo, its OAuth grant and that the collection is not a policy record before it commits (packages/pds/src/api/com/atproto/space/createRecord.ts). Stratos treats any record in a member repo as an unverified claim until its own membership and boundary state agree.",
    unknown:
      'What a pinned November host does. An August probe of an earlier alpha build reported that such a write succeeded; the repository keeps its commit message, not its output or the build it ran against, and its first version did not ensure the writer was a second, unrelated account.',
    carriedBy: [],
  },
  {
    id: 'post-uri-and-text-in-real-feed-response',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'The exact new post URI and text appear in a real feed HTTP response, not only on a rendered page.',
    expected:
      'The feed response carries the URI the write returned: at:space/ for a PDS-custody post, at:// for a Stratos-custody post.',
    unknown: 'The URI the host returns for a created record.',
    observed:
      'The November 26 published host returned the exact dotted-authority URI recorded in `uri-probe-receipt.json`.',
    carriedBy: ['baseline', 'ordinary-custody'],
  },
  {
    id: 'nonterminal-mac-tamper-never-promoted',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'A page with a corrupted commit MAC that is not the terminal page promotes nothing.',
    expected:
      'The feed generator promotes only after every page MAC and the terminal set hash verify.',
    unknown:
      'Needs a way to corrupt one page in transit, for example a proxy in front of the host.',
    carriedBy: [],
  },
  {
    id: 'terminal-set-hash-mismatch-never-promoted',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'A terminal page whose set hash does not match the records applied promotes nothing.',
    expected:
      "The set hash of the whole repo, kept from the stored base and updated by each op, must equal the commit's data before anything is promoted.",
    unknown: 'As above.',
    carriedBy: [],
  },
  {
    id: 'non-post-record-contributes-to-integrity',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'A record of a collection the feed does not serve still counts in the integrity hash of the repo.',
    expected: 'Every record of the repo is hashed, whatever its collection.',
    unknown: 'How the host orders and pages such records.',
    carriedBy: [],
  },
  {
    id: 'full-page-then-empty-terminal',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'A repo that exactly fills a page is followed by an empty terminal page and verifies.',
    expected:
      "A page without a cursor ends the poll, whatever its ops, and only that page's commit is proven and promoted; a page with a cursor is never the last.",
    unknown:
      'Whether the host sends a cursor after a full page and then an empty page, or ends on the full page.',
    carriedBy: [],
  },
  {
    id: 'expired-cursor-replaced-by-verified-star',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'When the host refuses an expired cursor, the feed generator reads a whole-repo archive and replaces the stored state only after it verifies.',
    expected:
      'The archive is read to the end and verified before any stored row changes.',
    unknown: 'How long the host keeps a cursor and the archive error words.',
    carriedBy: [],
  },
  {
    id: 'crash-restart-reaches-verified-terminal-revision',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'Stopping the feed generator mid-sync and starting it again ends at the verified terminal revision with nothing half-applied.',
    expected: 'Nothing is promoted until verification ends; a restart resyncs.',
    unknown: 'The restart timing against a real host.',
    carriedBy: [],
  },
  {
    id: 'host-and-kem-key-rotation',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'After a member moves host or rotates the key the host uses for the encrypted commit data, the next poll refreshes the key once and verifies.',
    expected:
      'One refresh and one new request after a failure with the old key; a stored host other than the target starts a replacement.',
    unknown: 'How the host publishes the rotated key.',
    carriedBy: [],
  },
  {
    id: 'membership-revoked-mid-poll',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'A member removed while a poll is running promotes nothing, other members are untouched, a member added again starts with a fresh generation, and a restart keeps the removal.',
    expected:
      'Each store write checks the generation, so a stale poll changes nothing.',
    unknown: 'Timing against a real host.',
    carriedBy: [],
  },
  {
    id: 'health-answers-while-a-sync-writes',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'While a poll or a whole-repo replacement of a large member repo writes to the store, the feed generator answers /health within two seconds.',
    expected:
      'The health handler reads the readiness gate and scheduler status independently of the store transaction.',
    unknown:
      'How long a store write takes on a large real repo, and whether /health waits for it.',
    carriedBy: [],
  },
  {
    id: 'malformed-or-truncated-archive-refused',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'A malformed or truncated whole-repo archive is refused and changes nothing.',
    expected: 'An archive over a limit fails as a unit with nothing written.',
    unknown: 'What the host sends when its own read fails midway.',
    carriedBy: [],
  },
  {
    id: 'suspension-and-offline-are-not-deletion',
    acceptanceRow: 'verified-sync-recovery',
    proves:
      'A suspended or unreachable host leaves the member projection in place and does not delete it.',
    expected: 'A failed target is counted as a failure.',
    unknown: 'The host error codes for suspension and takedown.',
    carriedBy: [],
  },
  {
    id: 'mixed-cache-migration-preserves-custody',
    acceptanceRow: 'migration-rollback',
    proves:
      'A cache that held both custodies before the upgrade keeps the Stratos-custody rows and rebuilds the PDS-custody projection by a verified sync.',
    expected:
      'The migration purges every space row and keeps everything else byte for byte; some of its tests run on encrypted file stores.',
    unknown:
      'A real kept database and the upstream migrations on a disposable database have not been rehearsed.',
    carriedBy: [],
  },
] as const

/** The runner command for one suite; the checklist repeats it for every item. */
export function runnerCommand(suite: string): string {
  const digest =
    suite === 'november-interop'
      ? ' \\\n  --pds-image-digest sha256:<digest>'
      : ''
  return [
    'pnpm exec tsx test/spaces-alignment/run-sandbox.ts \\',
    '  --sandbox-dir <sandbox checkout> \\',
    '  --source "$(git rev-parse --show-toplevel)" \\',
    `  --suite ${suite} \\`,
    '  --review-receipt <receipt file> \\',
    `  --report-dir <new directory>${digest}`,
  ].join('\n')
}

/**
 * The per-journey section of the checklist. The checklist page holds this text
 * unchanged, and a test fails when the two differ.
 */
export function renderJourneyChecklist(
  journeys: readonly Journey[] = JOURNEYS,
): string {
  return journeys
    .map((journey, index) => {
      const carrier = journey.carriedBy[0]
      const hasFixture = syncFixtures.some(
        (fixture) => fixture.id === journey.id,
      )
      const command =
        journey.id === 'canonical-uri-at-each-boundary'
          ? 'Run `november-positive` for the positive journey; the complete suite still requires all journeys.'
          : journey.id === 'upstream-standard-mint-control'
            ? 'Run `november-interop` for the published PDS personal-space mint and verified read. Use the per-group progress to locate a host failure.'
            : carrier
              ? `Run \`${carrier}\` (command below); it carries this journey in a ported form${
                  journey.carriedBy.length > 1
                    ? `, as do ${journey.carriedBy
                        .slice(1)
                        .map((id) => `\`${id}\``)
                        .join(' and ')}`
                    : ''
                }.`
              : hasFixture
                ? 'Run `november-interop` for fixture evidence. The pinned-host observation remains open.'
                : 'No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.'
      return [
        `### ${index + 1}. \`${journey.id}\``,
        '',
        `- Closes: ${ACCEPTANCE_ROWS[journey.acceptanceRow]}`,
        `- Proves: ${journey.proves}`,
        `- Expected: ${journey.expected}`,
        journey.observed
          ? `- Observed: ${journey.observed}`
          : `- Unknown: ${journey.unknown}`,

        `- Command: ${command}`,
        '- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.',
      ].join('\n')
    })
    .join('\n\n')
}
