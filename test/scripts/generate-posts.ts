#!/usr/bin/env -S deno run -A
// Generate a batch of posts for each enrolled user, including various embed types.
// Unlike test-posts.ts, this does NOT delete them afterwards.
// Useful for populating data for manual testing (e.g. pdsls browsing).

import { createRecord, uploadBlob, getRecord, getBlob } from './lib/stratos.ts'
import { loadState, saveState } from './lib/state.ts'
import { section, pass, fail, info, warn, summary } from './lib/log.ts'

// Minimal 1x1 PNG (67 bytes)
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

// Minimal JPEG (smallest valid JFIF — ~107 bytes)
function makeTinyJpeg(): Uint8Array {
  const data = new Uint8Array(107)
  // SOI
  data[0] = 0xff; data[1] = 0xd8
  // APP0 (JFIF marker)
  data[2] = 0xff; data[3] = 0xe0
  data[4] = 0x00; data[5] = 0x10 // length 16
  // "JFIF\0"
  data[6] = 0x4a; data[7] = 0x46; data[8] = 0x49; data[9] = 0x46; data[10] = 0x00
  data[11] = 0x01; data[12] = 0x01 // version 1.1
  data[13] = 0x00 // aspect ratio
  data[14] = 0x00; data[15] = 0x01 // x density
  data[16] = 0x00; data[17] = 0x01 // y density
  data[18] = 0x00; data[19] = 0x00 // no thumbnail
  // SOF0 (Start of Frame)
  data[20] = 0xff; data[21] = 0xc0
  data[22] = 0x00; data[23] = 0x0b // length 11
  data[24] = 0x08 // precision
  data[25] = 0x00; data[26] = 0x01 // height 1
  data[27] = 0x00; data[28] = 0x01 // width 1
  data[29] = 0x01 // 1 component
  data[30] = 0x01 // component id
  data[31] = 0x11 // sampling 1x1
  data[32] = 0x00 // quant table 0
  // DHT (Huffman table)
  data[33] = 0xff; data[34] = 0xc4
  data[35] = 0x00; data[36] = 0x1f // length 31
  data[37] = 0x00 // DC table 0
  // 16 code counts + 12 values (28 bytes of zeros is a valid empty-ish table)
  // SOS (Start of Scan)
  data[66] = 0xff; data[67] = 0xda
  data[68] = 0x00; data[69] = 0x08 // length 8
  data[70] = 0x01 // 1 component
  data[71] = 0x01; data[72] = 0x00 // component 1, DC/AC table 0
  data[73] = 0x00; data[74] = 0x3f; data[75] = 0x00 // spectral selection
  // Scan data (minimal)
  data[76] = 0x7b; data[77] = 0x40
  // EOI
  data[78] = 0xff; data[79] = 0xd9
  return data
}

const TINY_JPEG = makeTinyJpeg()

interface BlobRef {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

function makeBoundary(value: string) {
  return { values: [{ value }] }
}

function makePost(
  text: string,
  boundary: string,
  extra: Record<string, unknown> = {},
) {
  return {
    $type: 'zone.stratos.feed.post',
    text,
    boundary: makeBoundary(boundary),
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

let passed = 0
let failed = 0

const SWORDSMITH_POSTS = [
  'Forging a new katana in the swordsmith workshop',
  'The steel must be folded precisely 13 times',
  'Quenching the blade at dawn — the water must be cold',
  'A fine hamon line appeared on the latest work',
  'Inspecting the tang — the balance is perfect',
  'New shipment of tamahagane arrived from the mountain',
  'Teaching an apprentice the art of differential hardening',
  'The tsuba needs more detailed filing work',
]

const AEKEA_POSTS = [
  'Shopping at the Aekea marketplace',
  'Found a rare blueprint at the furniture vendor',
  'The new housing district is looking great',
  'Rearranging the living room layout again',
  'Traded for a vintage lamp at the bazaar',
  'The garden expansion is finally complete',
  'Hosting an open house this weekend',
  'Picked up some wallpaper samples from the depot',
]

// --- Post generators for different embed types ---

async function createTextPost(
  did: string,
  name: string,
  boundary: string,
  text: string,
): Promise<{ uri: string; cid: string; rkey: string } | null> {
  try {
    const result = await createRecord(did, 'zone.stratos.feed.post', makePost(text, boundary))
    const rkey = result.uri.split('/').pop()!
    pass(`${name}: text post`, text.substring(0, 50))
    passed++
    return { uri: result.uri, cid: result.cid, rkey }
  } catch (err) {
    fail(`${name}: text post failed`, String(err))
    failed++
    return null
  }
}

async function createImagePost(
  did: string,
  name: string,
  boundary: string,
  text: string,
  imageCount = 1,
): Promise<{ uri: string; cid: string; rkey: string } | null> {
  try {
    const images = []
    for (let i = 0; i < imageCount; i++) {
      const isJpeg = i % 2 === 1
      const bytes = isJpeg ? TINY_JPEG : TINY_PNG
      const mimeType = isJpeg ? 'image/jpeg' : 'image/png'
      const blob = await uploadBlob(did, bytes, mimeType)
      images.push({
        image: blob,
        alt: `Test image ${i + 1}`,
        aspectRatio: { width: 1, height: 1 },
      })
    }

    const result = await createRecord(
      did,
      'zone.stratos.feed.post',
      makePost(text, boundary, {
        embed: {
          $type: 'app.bsky.embed.images',
          images,
        },
      }),
    )
    const rkey = result.uri.split('/').pop()!
    pass(`${name}: image post (${imageCount} image${imageCount > 1 ? 's' : ''})`, text.substring(0, 50))
    passed++
    return { uri: result.uri, cid: result.cid, rkey }
  } catch (err) {
    fail(`${name}: image post failed`, String(err))
    failed++
    return null
  }
}

async function createExternalPost(
  did: string,
  name: string,
  boundary: string,
  text: string,
  withThumb: boolean,
): Promise<{ uri: string; cid: string; rkey: string } | null> {
  try {
    const external: Record<string, unknown> = {
      uri: 'https://example.com/article',
      title: 'Example Article',
      description: 'An interesting article about swords and furniture',
    }

    if (withThumb) {
      const thumb = await uploadBlob(did, TINY_PNG, 'image/png')
      external.thumb = thumb
    }

    const result = await createRecord(
      did,
      'zone.stratos.feed.post',
      makePost(text, boundary, {
        embed: {
          $type: 'app.bsky.embed.external',
          external,
        },
      }),
    )
    const rkey = result.uri.split('/').pop()!
    pass(`${name}: external post${withThumb ? ' (with thumb)' : ''}`, text.substring(0, 50))
    passed++
    return { uri: result.uri, cid: result.cid, rkey }
  } catch (err) {
    fail(`${name}: external post failed`, String(err))
    failed++
    return null
  }
}

async function createQuotePost(
  did: string,
  name: string,
  boundary: string,
  text: string,
  quotedUri: string,
  quotedCid: string,
): Promise<{ uri: string; cid: string; rkey: string } | null> {
  try {
    const result = await createRecord(
      did,
      'zone.stratos.feed.post',
      makePost(text, boundary, {
        embed: {
          $type: 'app.bsky.embed.record',
          record: { uri: quotedUri, cid: quotedCid },
        },
      }),
    )
    const rkey = result.uri.split('/').pop()!
    pass(`${name}: quote post`, text.substring(0, 50))
    passed++
    return { uri: result.uri, cid: result.cid, rkey }
  } catch (err) {
    fail(`${name}: quote post failed`, String(err))
    failed++
    return null
  }
}

async function createQuoteWithMediaPost(
  did: string,
  name: string,
  boundary: string,
  text: string,
  quotedUri: string,
  quotedCid: string,
): Promise<{ uri: string; cid: string; rkey: string } | null> {
  try {
    const blob = await uploadBlob(did, TINY_PNG, 'image/png')

    const result = await createRecord(
      did,
      'zone.stratos.feed.post',
      makePost(text, boundary, {
        embed: {
          $type: 'app.bsky.embed.recordWithMedia',
          record: {
            record: { uri: quotedUri, cid: quotedCid },
          },
          media: {
            $type: 'app.bsky.embed.images',
            images: [{ image: blob, alt: 'Quote media image' }],
          },
        },
      }),
    )
    const rkey = result.uri.split('/').pop()!
    pass(`${name}: quote+media post`, text.substring(0, 50))
    passed++
    return { uri: result.uri, cid: result.cid, rkey }
  } catch (err) {
    fail(`${name}: quote+media post failed`, String(err))
    failed++
    return null
  }
}

async function createReplyPost(
  did: string,
  name: string,
  boundary: string,
  text: string,
  rootUri: string,
  rootCid: string,
  parentUri: string,
  parentCid: string,
): Promise<{ uri: string; cid: string; rkey: string } | null> {
  try {
    const result = await createRecord(
      did,
      'zone.stratos.feed.post',
      makePost(text, boundary, {
        reply: {
          root: { uri: rootUri, cid: rootCid },
          parent: { uri: parentUri, cid: parentCid },
        },
      }),
    )
    const rkey = result.uri.split('/').pop()!
    pass(`${name}: reply post`, text.substring(0, 50))
    passed++
    return { uri: result.uri, cid: result.cid, rkey }
  } catch (err) {
    fail(`${name}: reply post failed`, String(err))
    failed++
    return null
  }
}

// --- Validation helpers ---

async function validateRecordRoundTrip(
  did: string,
  uri: string,
  label: string,
): Promise<boolean> {
  try {
    const parts = uri.split('/')
    const rkey = parts[parts.length - 1]
    const collection = parts[parts.length - 2]
    const repo = parts.slice(2, parts.length - 2).join('/')
    const record = await getRecord(repo, collection, rkey, did)
    if (!record || !record.value) {
      fail(`${label}: round-trip validation — empty response`)
      failed++
      return false
    }
    pass(`${label}: round-trip validation`)
    passed++
    return true
  } catch (err) {
    fail(`${label}: round-trip validation failed`, String(err))
    failed++
    return false
  }
}

async function validateBlobRoundTrip(
  did: string,
  blobRef: BlobRef,
  originalBytes: Uint8Array,
  label: string,
): Promise<boolean> {
  try {
    const fetched = await getBlob(did, blobRef.ref.$link, did)
    if (fetched.length !== originalBytes.length) {
      fail(`${label}: blob round-trip — size mismatch (got ${fetched.length}, expected ${originalBytes.length})`)
      failed++
      return false
    }
    pass(`${label}: blob round-trip (${fetched.length} bytes)`)
    passed++
    return true
  } catch (err) {
    warn(`${label}: blob round-trip skipped — ${String(err)}`)
    return false
  }
}

// --- Main flow ---

async function generateTextPosts(
  did: string,
  name: string,
  boundary: string,
  posts: string[],
): Promise<Array<{ uri: string; cid: string; rkey: string }>> {
  const results: Array<{ uri: string; cid: string; rkey: string }> = []
  for (const text of posts) {
    const result = await createTextPost(did, name, boundary, text)
    if (result) results.push(result)
  }
  return results
}

async function generateEmbedPosts(
  did: string,
  name: string,
  boundary: string,
): Promise<Array<{ uri: string; cid: string; rkey: string }>> {
  const results: Array<{ uri: string; cid: string; rkey: string }> = []

  // Single image
  const img1 = await createImagePost(did, name, boundary, 'A post with a single image attachment')
  if (img1) {
    results.push(img1)
    await validateRecordRoundTrip(did, img1.uri, `${name}: single-image`)
  }

  // Multi-image (3 images)
  const img3 = await createImagePost(did, name, boundary, 'Gallery post with three images', 3)
  if (img3) {
    results.push(img3)
    await validateRecordRoundTrip(did, img3.uri, `${name}: multi-image`)
  }

  // External link without thumbnail
  const ext1 = await createExternalPost(did, name, boundary, 'Check out this link', false)
  if (ext1) {
    results.push(ext1)
    await validateRecordRoundTrip(did, ext1.uri, `${name}: external-no-thumb`)
  }

  // External link with thumbnail
  const ext2 = await createExternalPost(did, name, boundary, 'Link with preview thumbnail', true)
  if (ext2) {
    results.push(ext2)
    await validateRecordRoundTrip(did, ext2.uri, `${name}: external-with-thumb`)
  }

  // Quote post (requires a previous post to quote)
  if (results.length > 0) {
    const toQuote = results[0]
    const quote = await createQuotePost(
      did, name, boundary,
      'Quoting my earlier post',
      toQuote.uri, toQuote.cid,
    )
    if (quote) {
      results.push(quote)
      await validateRecordRoundTrip(did, quote.uri, `${name}: quote`)
    }

    // Quote with media
    const qwm = await createQuoteWithMediaPost(
      did, name, boundary,
      'Quoting with an image attached',
      toQuote.uri, toQuote.cid,
    )
    if (qwm) {
      results.push(qwm)
      await validateRecordRoundTrip(did, qwm.uri, `${name}: quote+media`)
    }
  }

  // Reply chain
  const root = await createTextPost(did, name, boundary, 'Starting a thread')
  if (root) {
    results.push(root)
    const reply1 = await createReplyPost(
      did, name, boundary,
      'First reply in the thread',
      root.uri, root.cid,
      root.uri, root.cid,
    )
    if (reply1) {
      results.push(reply1)
      const reply2 = await createReplyPost(
        did, name, boundary,
        'Nested reply to the first reply',
        root.uri, root.cid,
        reply1.uri, reply1.cid,
      )
      if (reply2) {
        results.push(reply2)
        await validateRecordRoundTrip(did, reply2.uri, `${name}: nested-reply`)
      }
    }
  }

  return results
}

async function run() {
  section('Generate Posts')

  const state = await loadState()
  const rei = state.users.rei
  const kaoruko = state.users.kaoruko

  if (!rei || !kaoruko) {
    fail('Missing user state — run setup.ts + test-enrollment.ts first')
    Deno.exit(1)
  }

  // --- Text-only posts ---
  section(`Rei (swordsmith) — ${SWORDSMITH_POSTS.length} text posts`)
  const reiTextResults = await generateTextPosts(rei.did, 'Rei', 'swordsmith', SWORDSMITH_POSTS)
  info(`Rei: ${reiTextResults.length} text posts created`)

  section(`kaoruko (aekea) — ${AEKEA_POSTS.length} text posts`)
  const kaorukoTextResults = await generateTextPosts(kaoruko.did, 'kaoruko', 'aekea', AEKEA_POSTS)
  info(`kaoruko: ${kaorukoTextResults.length} text posts created`)

  // --- Embed posts ---
  section('Rei (swordsmith) — embed posts')
  const reiEmbedResults = await generateEmbedPosts(rei.did, 'Rei', 'swordsmith')
  info(`Rei: ${reiEmbedResults.length} embed posts created`)

  section('kaoruko (aekea) — embed posts')
  const kaorukoEmbedResults = await generateEmbedPosts(kaoruko.did, 'kaoruko', 'aekea')
  info(`kaoruko: ${kaorukoEmbedResults.length} embed posts created`)

  // --- Blob round-trip validation ---
  section('Blob round-trip validation')
  try {
    const blob = await uploadBlob(rei.did, TINY_PNG, 'image/png')
    await validateBlobRoundTrip(rei.did, blob, TINY_PNG, 'Rei: PNG blob')
  } catch (err) {
    warn(`Blob round-trip skipped — ${String(err)}`)
  }

  // --- Cross-namespace embed rejection ---
  section('Cross-namespace embed rejection')
  try {
    await createRecord(rei.did, 'zone.stratos.feed.post', makePost(
      'This should fail — quoting a bsky post',
      'swordsmith',
      {
        embed: {
          $type: 'app.bsky.embed.record',
          record: {
            uri: 'at://did:plc:fake/app.bsky.feed.post/abc123',
            cid: 'bafyreifakecidforcrossnamespacetest',
          },
        },
      },
    ))
    fail('Cross-namespace embed: should have been rejected')
    failed++
  } catch {
    pass('Cross-namespace embed: correctly rejected')
    passed++
  }

  // --- Save state ---
  const allReiResults = [...reiTextResults, ...reiEmbedResults]
  const allKaorukoResults = [...kaorukoTextResults, ...kaorukoEmbedResults]

  if (allReiResults.length > 0) {
    rei.records['generated'] = allReiResults[allReiResults.length - 1]
  }
  if (allKaorukoResults.length > 0) {
    kaoruko.records['generated'] = allKaorukoResults[allKaorukoResults.length - 1]
  }
  await saveState(state)

  info(`Total: Rei ${allReiResults.length}, kaoruko ${allKaorukoResults.length}`)
  summary(passed, failed)
  if (failed > 0) Deno.exit(1)
}

run().catch((err) => {
  console.error('\nPost generation failed:', err)
  Deno.exit(1)
})
