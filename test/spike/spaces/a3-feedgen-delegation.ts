/**
 * Spike A3 — can the feed generator's `did:web` self-mint a delegation token
 * that Stratos accepts?
 *
 * The feedgen has a `did:web` and no PDS, so it cannot use
 * `com.atproto.space.getDelegationToken`, which is the PDS convenience for
 * accounts whose key the PDS custodies. Upstream places no DID-method limit on
 * a delegation issuer, so the feedgen should be able to sign its own token.
 *
 * This drives the REAL Stratos verifier, `verifyDelegationToken`, against a
 * token signed by a `did:web` key whose document the script serves. It answers
 * the kill criterion directly: does Stratos reject a `did:web` issuer?
 *
 * Run from stratos-service: pnpm exec tsx ../test/spike/spaces/a3-feedgen-delegation.ts
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Secp256k1Keypair } from '@atproto/crypto'
import { IdResolver } from '@atproto/identity'
import {
  ATPROTO_KID,
  verifyDelegationToken,
} from '../../../stratos-service/src/infra/auth/delegation-verifier.js'

const FEEDGEN_PORT = 3200
const FEEDGEN_DID = `did:web:localhost%3A${FEEDGEN_PORT}`
// Stratos is the space authority. It is not booted here; only its DID string
// matters, because the verifier compares `sub`/`aud` against it.
const STRATOS_DID = 'did:web:localhost%3A3100'
const DELEGATION_TYP = 'atproto-space-delegation+jwt'

const b64urlJson = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString('base64url')

const log = (step: string, detail: unknown) =>
  console.log(`\n── ${step}\n`, detail)

async function main() {
  // The feedgen signs with a Secp256k1 key (stratos-feedgen/src/bin/main.ts:23)
  // and publishes `#atproto` (stratos-feedgen/src/server.ts:69).
  const feedgenKey = await Secp256k1Keypair.create({ exportable: true })
  const publicKeyMultibase = feedgenKey.did().slice('did:key:'.length)

  const didDoc = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: FEEDGEN_DID,
    verificationMethod: [
      {
        id: `${FEEDGEN_DID}#atproto`,
        type: 'Multikey',
        controller: FEEDGEN_DID,
        publicKeyMultibase,
      },
    ],
    service: [
      {
        id: '#stratos_feedgen',
        type: 'NorthskyStratosFeedGen',
        serviceEndpoint: `http://localhost:${FEEDGEN_PORT}`,
      },
    ],
  }

  const server = createServer((req, res) => {
    if (req.url === '/.well-known/did.json') {
      res.setHeader('content-type', 'application/did+ld+json')
      res.end(JSON.stringify(didDoc))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) =>
    server.listen(FEEDGEN_PORT, '0.0.0.0', resolve),
  )
  log('feedgen DID document served', {
    did: FEEDGEN_DID,
    alg: feedgenKey.jwtAlg,
  })

  try {
    const spaceUri = `at://${STRATOS_DID}/space/zone.stratos.space.feed/spike`
    const now = Math.floor(Date.now() / 1000)
    const header = {
      typ: DELEGATION_TYP,
      alg: feedgenKey.jwtAlg,
      kid: ATPROTO_KID,
    }
    const payload = {
      iss: FEEDGEN_DID,
      sub: spaceUri,
      aud: `${STRATOS_DID}#atproto_space_host`,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    }
    const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
    const sig = await feedgenKey.sign(new TextEncoder().encode(signingInput))
    const token = `${signingInput}.${Buffer.from(sig).toString('base64url')}`

    log('self-minted delegation token', payload)

    const idResolver = new IdResolver()
    const result = await verifyDelegationToken(token, {
      serviceDid: STRATOS_DID,
      idResolver,
    })

    log('Stratos verifyDelegationToken accepted it', result)
    console.log(`\n${'='.repeat(60)}`)
    console.log(
      'RESULT: PASS — Stratos accepts a did:web self-minted delegation token.',
    )
    console.log('='.repeat(60))
  } catch (err) {
    log('Stratos rejected the token', {
      name: (err as Error).name,
      message: (err as Error).message,
    })
    console.log(`\n${'='.repeat(60)}`)
    console.log('RESULT: FAIL — Stratos rejects a did:web delegation issuer.')
    console.log('='.repeat(60))
    process.exitCode = 1
  } finally {
    server.close()
  }
}

main().catch((err) => {
  console.error('spike failed:', err)
  process.exitCode = 1
})
