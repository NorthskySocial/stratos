// Run: cd test/scripts && deno test --allow-read --allow-env lib

import assert from 'node:assert/strict'

interface BoundaryCase {
  name: string
  boundary: string
  spaceType: string
  uri: string
}

const CORPUS = new URL(
  '../../spaces-alignment/november/fixtures/space-uri-conformance.json',
  import.meta.url,
)

// config.ts refuses to load without these, so set them before importing it.
Deno.env.set('PDS_HOST', 'pds.example.test')
Deno.env.set('PDS_ADMIN_PASSWORD', 'not-a-real-password')
const { SERVICE_DID, SPACE_TYPE, spaceUriFor } = await import('./config.ts')

async function feedBoundaryCases(): Promise<BoundaryCase[]> {
  const corpus = JSON.parse(await Deno.readTextFile(CORPUS)) as {
    boundaries: BoundaryCase[]
  }
  return corpus.boundaries.filter((entry) => entry.spaceType === SPACE_TYPE)
}

Deno.test(
  'spaceUriFor matches the corpus boundary cases of the feed type',
  async () => {
    const cases = await feedBoundaryCases()
    assert.ok(cases.length > 0, 'the corpus has feed-type boundary cases')
    for (const entry of cases) {
      const slash = entry.boundary.indexOf('/')
      const authority = entry.boundary.slice(0, slash)
      const skey = entry.boundary.slice(slash + 1)
      assert.equal(spaceUriFor(skey, authority), entry.uri, entry.name)
    }
  },
)

Deno.test('spaceUriFor takes the service DID as authority by default', () => {
  assert.equal(
    spaceUriFor('swordsmith'),
    `at:space/${SERVICE_DID}/${SPACE_TYPE}/swordsmith`,
  )
})
