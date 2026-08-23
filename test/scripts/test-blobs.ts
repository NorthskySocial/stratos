#!/usr/bin/env -S deno run -A
// Blob test — upload, boundary-scoped getBlob access, orphan revocation.
//
// Blob access follows the records that embed the blob: a viewer needs a
// boundary shared with at least one embedding record. Deleting the last
// embedding record revokes shared-viewer access (delete.ts removes the
// record-blob associations).

import { DOMAINS } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import {
  createRecord,
  deleteRecord,
  getBlob,
  uploadBlob,
} from './lib/stratos.ts'
import { assert, fail, finish, pass, section } from './lib/log.ts'

const COLLECTION = 'zone.stratos.feed.post'
const MIME_TYPE = 'image/png'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * A CID carries no checksum, so swapping one base32 character in the digest
 * yields a valid CID that references nothing.
 */
function alterCid(cid: string): string {
  const i = 10
  const swapped = cid[i] === 'a' ? 'b' : 'a'
  return cid.slice(0, i) + swapped + cid.slice(i + 1)
}

async function run() {
  section('Phase 4c: Blobs — upload & boundary-scoped access')

  const state = await loadState()
  const rei = state.users.rei // author, swordsmith
  const sakura = state.users.sakura // shares swordsmith
  const kaoruko = state.users.kaoruko // aekea only
  if (!rei?.enrolled || !sakura?.enrolled || !kaoruko?.enrolled) {
    fail('Users rei, sakura, kaoruko must be enrolled — run earlier phases')
    finish()
  }

  const blobBytes = crypto.getRandomValues(new Uint8Array(2048))

  section('Upload')
  let blobCid = ''
  try {
    const uploaded = await uploadBlob(rei.did, blobBytes, MIME_TYPE)
    blobCid = uploaded.blob.ref.$link
    assert(
      uploaded.blob.size === blobBytes.length && blobCid.length > 0,
      'uploadBlob returns a blob ref for the uploaded bytes',
      `cid=${blobCid} size=${uploaded.blob.size}`,
    )
  } catch (err) {
    fail('uploadBlob as rei', String(err))
    finish()
  }

  section('Create post embedding the blob')
  const record = {
    $type: COLLECTION,
    text: 'Kagome took a photo at the Bone-Eater Well',
    boundary: { values: [{ value: DOMAINS.swordsmith }] },
    embed: {
      $type: 'zone.stratos.embed.images',
      images: [
        {
          image: {
            $type: 'blob',
            ref: { $link: blobCid },
            mimeType: MIME_TYPE,
            size: blobBytes.length,
          },
          alt: 'A photo from the Sengoku era',
        },
      ],
    },
    createdAt: new Date().toISOString(),
  }

  let rkey = ''
  try {
    const created = await createRecord(rei.did, COLLECTION, record)
    rkey = created.uri.split('/').pop() ?? ''
    pass('createRecord with an embedded blob', created.uri)
  } catch (err) {
    fail('createRecord with an embedded blob', String(err))
    finish()
  }

  section('Boundary-scoped access')
  const asOwner = await getBlob(rei.did, rei.did, blobCid)
  assert(
    asOwner.status === 200 && bytesEqual(asOwner.bytes, blobBytes),
    'owner fetches the blob bytes',
    `status=${asOwner.status} bytes=${asOwner.bytes.length}`,
  )

  const asSakura = await getBlob(sakura.did, rei.did, blobCid)
  assert(
    asSakura.status === 200 && bytesEqual(asSakura.bytes, blobBytes),
    'viewer sharing the boundary fetches identical bytes',
    `status=${asSakura.status} bytes=${asSakura.bytes.length}`,
  )

  const asKaoruko = await getBlob(kaoruko.did, rei.did, blobCid)
  assert(
    asKaoruko.status === 400 && asKaoruko.error === 'BlobBlocked',
    'viewer without the boundary is denied (BlobBlocked)',
    `status=${asKaoruko.status} error=${asKaoruko.error}`,
  )

  const asAnon = await getBlob(null, rei.did, blobCid)
  assert(
    asAnon.status === 400 && asAnon.error === 'BlobBlocked',
    'unauthenticated viewer is denied (BlobBlocked)',
    `status=${asAnon.status} error=${asAnon.error}`,
  )

  section('Unknown blob CID')
  const unknown = await getBlob(rei.did, rei.did, alterCid(blobCid))
  assert(
    unknown.status === 400 && unknown.error === 'BlobNotFound',
    'unknown CID fails cleanly (BlobNotFound, no 500)',
    `status=${unknown.status} error=${unknown.error}`,
  )

  section('Orphaned blob after record delete')
  try {
    await deleteRecord(rei.did, COLLECTION, rkey)
    pass('deleteRecord removes the embedding post')
  } catch (err) {
    fail('deleteRecord removes the embedding post', String(err))
  }

  const afterDelete = await getBlob(sakura.did, rei.did, blobCid)
  assert(
    afterDelete.status === 400 && afterDelete.error === 'BlobBlocked',
    'shared-viewer access is revoked once no record embeds the blob',
    `status=${afterDelete.status} error=${afterDelete.error}`,
  )

  finish()
}

run().catch((err) => {
  console.error('\nBlob test failed:', err)
  Deno.exit(1)
})
