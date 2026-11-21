/**
 * The journeys a person walks the day a host accepts the new space spelling.
 * Each one names the acceptance row it closes. Nothing here has run against a
 * host: `expected` is what the repository's own tests lead us to predict and
 * `unknown` is what only a host can show.
 */

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
    carriedBy: [],
  },
  {
    id: 'ordinary-custody-create-feed-delete',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A Stratos-custody member on an ordinary PDS posts through the service, the post appears in the feed from the Rust feed generator, a member of another boundary is denied, and the delete removes it.',
    expected:
      'Passes: the journey touches no space URI and no credential from the spaces PDS.',
    unknown:
      'The suite has never run; the first run may show a stack or driver fault.',
    carriedBy: ['ordinary-custody'],
  },
  {
    id: 'two-authors-on-one-host',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'Two PDS-custody members who share one reference host each have their own record read through a credential for their own repo, and neither read returns the other member.',
    expected:
      'Each read is addressed to the author, never to the authority, and a credential for one member is refused for the other.',
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
      'The host resolves the space type declaration during OAuth and enforces the explicit space grant on a write.',
    expected:
      'The sandbox declaration fixture carries name and title and the three collections of the repository declaration, which carries title only.',
    unknown:
      'Whether the host in use still requires name, and how it answers the space scope string.',
    carriedBy: ['baseline'],
  },
  {
    id: 'inspector-reads-own-record-through-oauth',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'The webapp inspector reads the signed-in member own PDS-custody record with that member OAuth grant.',
    expected:
      'The inspector classifies the address, then sends three requests addressed to the author and nothing for an address it refuses.',
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
      'The credential carries the #atproto_pds audience and the service signature; the receiver verifies it against the authority DID document without contacting Stratos.',
    unknown:
      'Whether the host accepts a credential minted by a foreign authority. This is the question the earlier probe left open.',
    carriedBy: ['standard-credential-transport', 'rust-production-interop'],
  },
  {
    id: 'upstream-standard-mint-control',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      "The host's own standard credential exchange works in the same stack, so a failure of the custom mint is not a stack fault.",
    expected: 'The exchange succeeds with a delegation and a signed proof.',
    unknown: 'The host exchange route at the pinned build.',
    carriedBy: ['standard-credential-transport', 'rust-production-interop'],
  },
  {
    id: 'wrong-key-and-wrong-owner-denied',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A presentation signed with the wrong key, and a credential for another owner, are refused by the host and by Stratos.',
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
    unknown: 'How the host issues the delegation for an OAuth session.',
    carriedBy: ['delegation-transport', 'credential-lifetime'],
  },
  {
    id: 'invalid-jwt-signature-refused-by-receiver',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A credential whose JWT signature is invalid is refused by the receiving verifier on the host and on Stratos.',
    expected: 'Refused before any record is read.',
    unknown: 'The host response.',
    carriedBy: ['standard-credential-transport'],
  },
  {
    id: 'renewal-and-revoked-member-denied',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'A credential renews with a fresh key, and after the member is removed a renewal and a read are denied.',
    expected:
      'Renewal after removal is denied by Stratos; a credential already issued lapses at its expiry.',
    unknown:
      'Whether the host honours removal sooner than expiry. No host route announces removal.',
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
      'Stratos treats any record in a member repo as an unverified claim until its own membership and boundary state agree.',
    unknown:
      'The open question of the earlier write probe: if the write succeeds, the host authorizes from the caller session scope alone.',
    carriedBy: [],
  },
  {
    id: 'post-uri-and-text-in-real-feed-response',
    acceptanceRow: 'mixed-custody-privacy',
    proves:
      'The exact new post URI and text appear in a real feed HTTP response, not only on a rendered page.',
    expected: 'The feed response carries the post URI in the new spelling.',
    unknown: 'The URI the host returns for a created record.',
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
      'The set hash is recomputed over the whole repo state and compared before promotion.',
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
    expected: 'An empty page ends the sync; only the terminal page promotes.',
    unknown: 'Whether the host sends an empty terminal page or ends early.',
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
      'The migration purges every space row and keeps everything else byte for byte; its tests run on file stores.',
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
      const command = carrier
        ? `Run \`${carrier}\` (command below); it carries this journey in a ported form${
            journey.carriedBy.length > 1
              ? `, as do ${journey.carriedBy
                  .slice(1)
                  .map((id) => `\`${id}\``)
                  .join(' and ')}`
              : ''
          }.`
        : 'No driver exists yet. Write one in `scenarios/november-interop.ts`; until then this item cannot be closed.'
      return [
        `### ${index + 1}. \`${journey.id}\``,
        '',
        `- Closes: ${ACCEPTANCE_ROWS[journey.acceptanceRow]}`,
        `- Proves: ${journey.proves}`,
        `- Expected: ${journey.expected}`,
        `- Unknown: ${journey.unknown}`,
        `- Command: ${command}`,
        '- Save: `receipt.json` (or `failure.json`) from the report directory, kept with the image digest you named.',
      ].join('\n')
    })
    .join('\n\n')
}
