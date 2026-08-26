/**
 * Spike A2 — does the upstream alpha spaces PDS accept a space credential that
 * Stratos minted?
 *
 * This is the primary risk in the mixed-mode design. Stratos is the space
 * AUTHORITY and a foreign PDS is the repo HOST. The host must verify a
 * Stratos-signed credential against the Stratos DID document, with no contact
 * back to Stratos.
 *
 * The script:
 *   1. Makes a Secp256k1 authority key and serves a `did:web` document for it,
 *      in the same shape that `stratos-service/src/index.ts` now serves.
 *   2. Mints a credential with the REAL minter, so the wire shape under test is
 *      the shipped one.
 *   3. Builds an ES256 DPoP proof the way upstream `packages/space/src/dpop.ts`
 *      does, and calls `com.atproto.space.getRecord` on the alpha PDS.
 *
 * PASS = any non-auth error, such as a missing space or repo. That proves the
 * host verified the credential and moved on to look for data.
 * FAIL = an auth error. That kills the design as drawn.
 *
 * Run: pnpm exec tsx test/spike/spaces/a2-foreign-credential.ts
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Secp256k1Keypair } from '@atproto/crypto'
import { JoseKey } from '@atproto/jwk-jose'
import { mintSpaceCredential } from '../../../stratos-service/src/features/space-credential/minter.js'

const DID_DOC_PORT = 3100
const PDS_URL = 'http://localhost:3010'
// The upstream did:web resolver rewrites https to http only for `localhost`,
// so the authority must be addressed by that exact hostname.
const AUTHORITY_DID = `did:web:localhost%3A${DID_DOC_PORT}`

// Mirrors the `#atproto_pns` default in stratos-service/src/config.ts.
const LEGACY_FRAGMENT = 'atproto_pns'
const SPACE_FRAGMENT = 'atproto'

const log = (step: string, detail: unknown) =>
  console.log(`\n── ${step}\n`, detail)

async function main() {
  const authorityKey = await Secp256k1Keypair.create({ exportable: true })
  const publicKeyMultibase = authorityKey.did().slice('did:key:'.length)

  // Step 1 — serve the DID document exactly as stratos-service now builds it.
  const didDoc = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: AUTHORITY_DID,
    verificationMethod: [
      {
        id: `${AUTHORITY_DID}#${LEGACY_FRAGMENT}`,
        type: 'Multikey',
        controller: AUTHORITY_DID,
        publicKeyMultibase,
      },
      {
        id: `${AUTHORITY_DID}#${SPACE_FRAGMENT}`,
        type: 'Multikey',
        controller: AUTHORITY_DID,
        publicKeyMultibase,
      },
    ],
    service: [
      {
        id: '#stratos',
        type: 'StratosService',
        serviceEndpoint: `http://localhost:${DID_DOC_PORT}`,
      },
    ],
  }

  let didDocRequests = 0
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/did.json') {
      didDocRequests += 1
      res.setHeader('content-type', 'application/did+ld+json')
      res.end(JSON.stringify(didDoc))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) =>
    server.listen(DID_DOC_PORT, '0.0.0.0', resolve),
  )
  log('authority DID document served', {
    did: AUTHORITY_DID,
    alg: authorityKey.jwtAlg,
    fragments: didDoc.verificationMethod.map((v) => v.id),
  })

  try {
    // Step 2 — DPoP key and the real minter.
    const dpopKey = await JoseKey.generate(['ES256'])
    const jkt = await dpopThumbprint(dpopKey)
    const spaceUri = `at://${AUTHORITY_DID}/space/zone.stratos.space.feed/spike`

    const { credential, payload } = await mintSpaceCredential({
      signingKey: authorityKey,
      issuerDid: AUTHORITY_DID,
      spaceUri,
      ttlSeconds: 300,
      jkt,
    })
    log('credential minted by the real Stratos minter', payload)

    // Step 3 — call the foreign host.
    const url = new URL(`${PDS_URL}/xrpc/com.atproto.space.getRecord`)
    url.searchParams.set('space', spaceUri)
    url.searchParams.set('repo', AUTHORITY_DID)
    url.searchParams.set('collection', 'zone.stratos.feed.post')
    url.searchParams.set('rkey', 'spike')

    const proof = await createDpopProof(dpopKey, {
      htm: 'GET',
      htu: url.toString(),
      credential,
    })

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `DPoP ${credential}`,
        dpop: proof,
      },
    })
    const body = await res.text()

    log('foreign PDS response', { status: res.status, body })

    // Negative control. A "repo not found" answer only proves the host
    // verified the credential if a BAD credential gets a different answer.
    // Flip one signature character to keep the shape and break the signature.
    const lastChar = credential.slice(-1)
    const tampered = credential.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A')
    const controlProof = await createDpopProof(dpopKey, {
      htm: 'GET',
      htu: url.toString(),
      credential: tampered,
    })
    const controlRes = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `DPoP ${tampered}`,
        dpop: controlProof,
      },
    })
    const controlBody = await controlRes.text()
    log('negative control — tampered signature', {
      status: controlRes.status,
      body: controlBody,
    })

    const authFailure = res.status === 401
    const controlRejected = controlRes.status === 401
    console.log(`\n${'='.repeat(60)}`)
    console.log(`DID document fetched by the PDS: ${didDocRequests} time(s)`)
    if (didDocRequests === 0) {
      console.log(
        'RESULT: INCONCLUSIVE — the PDS never fetched the authority document.',
      )
    } else if (authFailure) {
      console.log('RESULT: FAIL — the host rejected the credential.')
    } else if (!controlRejected) {
      console.log(
        'RESULT: INCONCLUSIVE — a tampered credential got the same answer, ' +
          'so the endpoint answers before it checks auth.',
      )
    } else {
      console.log(
        'RESULT: PASS — the host verified the credential and looked for data. ' +
          'A tampered credential is rejected, so auth really ran.',
      )
    }
    console.log('='.repeat(60))
  } finally {
    server.close()
  }
}

/** SHA-256 JWK thumbprint of the DPoP key, per RFC 9449. */
async function dpopThumbprint(key: JoseKey): Promise<string> {
  const jwk = key.bareJwk
  if (!jwk) throw new Error('DPoP key has no public JWK')
  // RFC 7638 requires the canonical member order for an EC key.
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  })
  return createHash('sha256').update(canonical).digest('base64url')
}

/** Mirrors createDpopProof in upstream packages/space/src/dpop.ts. */
async function createDpopProof(
  key: JoseKey,
  opts: { htm: string; htu: string; credential?: string },
): Promise<string> {
  const parsed = new URL(opts.htu)
  const claims: Record<string, unknown> = {
    jti: randomBytes(16).toString('hex'),
    htm: opts.htm,
    htu: parsed.origin + parsed.pathname,
    iat: Math.floor(Date.now() / 1000),
  }
  if (opts.credential !== undefined) {
    claims.ath = createHash('sha256')
      .update(opts.credential)
      .digest('base64url')
  }
  return key.createJwt(
    { alg: 'ES256', typ: 'dpop+jwt', jwk: key.bareJwk },
    claims,
  )
}

main().catch((err) => {
  console.error('spike failed:', err)
  process.exitCode = 1
})
