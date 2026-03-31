import {
  ipldToLex as esmIpldToLex,
  BlobRef as EsmBlobRef,
} from '@atproto/lexicon'
import { CID } from '@atproto/lex-data'
import { CidLinkWrapper } from '@atcute/cid'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cjsLexicon = require('@atproto/lexicon')
const cjsIpldToLex = cjsLexicon.ipldToLex
const CjsBlobRef = cjsLexicon.BlobRef

console.log('ESM ipldToLex === CJS ipldToLex:', esmIpldToLex === cjsIpldToLex)
console.log('ESM BlobRef === CJS BlobRef:', EsmBlobRef === CjsBlobRef)

// Create a test blob with multiformats CID
const fakeCidBytes = new Uint8Array([
  0x01,
  0x55,
  0x12,
  0x20,
  ...new Array(32).fill(0xab),
])
const cidLink = new CidLinkWrapper(fakeCidBytes)
const cid = CID.parse(cidLink.$link)

const blob = { $type: 'blob', ref: cid, mimeType: 'image/jpeg', size: 12345 }

// Test ESM ipldToLex
const esmResult = esmIpldToLex(blob)
console.log('\n--- ESM ipldToLex ---')
console.log('Result is EsmBlobRef:', esmResult instanceof EsmBlobRef)
console.log('Result is CjsBlobRef:', esmResult instanceof CjsBlobRef)

// Test CJS ipldToLex
const cjsResult = cjsIpldToLex(blob)
console.log('\n--- CJS ipldToLex ---')
console.log('Result is EsmBlobRef:', cjsResult instanceof EsmBlobRef)
console.log('Result is CjsBlobRef:', cjsResult instanceof CjsBlobRef)
