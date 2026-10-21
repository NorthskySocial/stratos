import { Secp256k1Keypair } from '@atproto/crypto'

const domain = Deno.env.get('SANDBOX_DOMAIN')
if (!domain) throw Error('SANDBOX_DOMAIN is required')
const feedgenHostLabel = Deno.env.get('FEEDGEN_HOST_LABEL') ?? 'feedgen'

const signingKey = (
  await Deno.readTextFile('/run/sandbox-secrets/feedgen-signing-key')
).trim()
const keypair = await Secp256k1Keypair.import(signingKey)
const signingKeyDid = keypair.did()
const feedgenDid = `did:web:${feedgenHostLabel}.${domain}`

await Deno.writeTextFile(
  '/runtime/feedgen.env',
  `FEEDGEN_PUBLIC_KEY_MULTIBASE=${signingKeyDid.slice('did:key:'.length)}\n`,
)
await Deno.writeTextFile(
  '/runtime/service-enrollments.json',
  JSON.stringify([
    { did: feedgenDid, boundaries: ['general'], signingKey: signingKeyDid },
  ]) + '\n',
)
await Promise.all([
  Deno.chmod('/runtime/feedgen.env', 0o644),
  Deno.chmod('/runtime/service-enrollments.json', 0o644),
])
