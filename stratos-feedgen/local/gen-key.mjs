// Generate a secp256k1 keypair for the local feedgen identity.
//
// Emits:
//   - the private key (hex) for FEEDGEN_SIGNING_KEY
//   - the public key multibase for did.json (publicKeyMultibase / did:key suffix)
//
// Run from the stratos/ workspace root so the @atproto/crypto workspace dep resolves:
//   node stratos-feedgen/local/gen-key.mjs
import { Secp256k1Keypair } from '@atproto/crypto'

const keypair = await Secp256k1Keypair.create({ exportable: true })
const privBytes = await keypair.export()
const privHex = Buffer.from(privBytes).toString('hex')
const didKey = keypair.did() // did:key:zQ3sh...
const multibase = didKey.replace(/^did:key:/, '')

console.log(JSON.stringify({ privHex, didKey, multibase }, null, 2))
