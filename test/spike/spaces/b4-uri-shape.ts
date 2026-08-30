/**
 * Spike B4 — does the existing read path survive a spaces record URI?
 *
 * A Stratos-custody record has the familiar three-part URI:
 *   at://{authorDid}/{collection}/{rkey}
 *
 * A spaces record, as the alpha PDS returns it, is seven parts and starts with
 * the space AUTHORITY, not the author:
 *   at://{authorityDid}/space/{type}/{skey}/{authorDid}/{collection}/{rkey}
 *
 * `webapp/src/lib/feed.ts:133` derives the author by taking the first segment.
 * That is correct for a custody record and wrong for a spaces record, where it
 * yields the authority. This script demonstrates the failure against the real
 * URI observed in spike A5, and checks the proposed fix.
 *
 * Run: pnpm exec tsx test/spike/spaces/b4-uri-shape.ts
 */

/** Copy of webapp/src/lib/feed.ts:133 as it stands today. */
function authorFromUri(uri: string): string {
  return uri.replace('at://', '').split('/')[0]
}

/**
 * Proposed replacement. A space record URI carries the literal `space` segment
 * in second position, and the author is the fifth segment.
 */
function authorFromUriFixed(uri: string): string {
  const parts = uri.replace('at://', '').split('/')
  if (parts[1] === 'space' && parts.length >= 7) return parts[4]
  return parts[0]
}

// Observed verbatim in spike A5 against spaces-alpha.host.bsky.network.
const SPACES_URI =
  'at://did:web:melioristic-outspokenly-roselyn.ngrok-free.dev' +
  '/space/zone.stratos.space.feed/spike' +
  '/did:plc:atbnxlrciwofkeceaup75ty7/zone.stratos.feed.post/spike1787732940930'
const CUSTODY_URI =
  'at://did:plc:stratoscustodyuser/zone.stratos.feed.post/local1'

const EXPECTED_SPACES_AUTHOR = 'did:plc:atbnxlrciwofkeceaup75ty7'
const EXPECTED_CUSTODY_AUTHOR = 'did:plc:stratoscustodyuser'

const cases = [
  { name: 'spaces record', uri: SPACES_URI, expect: EXPECTED_SPACES_AUTHOR },
  { name: 'custody record', uri: CUSTODY_URI, expect: EXPECTED_CUSTODY_AUTHOR },
]

console.log('current authorFromUri (webapp/src/lib/feed.ts:133)')
let currentOk = true
for (const c of cases) {
  const got = authorFromUri(c.uri)
  const ok = got === c.expect
  if (!ok) currentOk = false
  console.log(`  ${ok ? 'ok  ' : 'WRONG'} ${c.name}: ${got}`)
}

console.log('\nproposed authorFromUriFixed')
let fixedOk = true
for (const c of cases) {
  const got = authorFromUriFixed(c.uri)
  const ok = got === c.expect
  if (!ok) fixedOk = false
  console.log(`  ${ok ? 'ok  ' : 'WRONG'} ${c.name}: ${got}`)
}

console.log(`\n${'='.repeat(62)}`)
console.log(`current helper handles both shapes: ${currentOk}`)
console.log(`proposed helper handles both shapes: ${fixedOk}`)
console.log(
  !currentOk && fixedOk
    ? 'RESULT: confirmed defect, and the proposed fix resolves it.'
    : 'RESULT: unexpected — re-check the assumptions above.',
)
console.log('='.repeat(62))
if (currentOk || !fixedOk) process.exitCode = 1
