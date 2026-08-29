/**
 * Spike A5 — write a record into a member's OWN PDS repo for a Stratos-owned
 * space, then read it back as the syncer.
 *
 * This closes the mixed-mode loop on the read side. Stratos is the space
 * AUTHORITY; the member's PDS is the repo HOST. The syncer holds only a
 * credential the authority minted, and must be able to pull the member's ops
 * from a host it does not control.
 *
 * The public alpha PDS must resolve the authority DID document, so the
 * document is exposed through an ngrok tunnel and the authority DID is
 * `did:web:<tunnel-host>`.
 *
 * Accounts come from ops/alpha-users.json, which stays outside this repo.
 * Writes are deliberately minimal: one record.
 *
 * Run from stratos-service: pnpm exec tsx ../test/spike/spaces/a5-foreign-repo.ts
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
import ngrok from '@ngrok/ngrok'
import { Secp256k1Keypair } from '@atproto/crypto'
import { JoseKey } from '@atproto/jwk-jose'
import { mintSpaceCredential } from '../../../stratos-service/src/features/space-credential/minter.js'

const REPO_ROOT = new URL('../../../', import.meta.url).pathname
const ACCOUNTS_PATH = `${REPO_ROOT}../ops/alpha-users.json`
const DID_DOC_PORT = 3400
const SPACE_TYPE = 'zone.stratos.space.feed'
const SPACE_SKEY = 'spike'
const COLLECTION = 'zone.stratos.feed.post'

loadEnv({ path: `${REPO_ROOT}.env` })

const log = (step: string, detail: unknown) =>
  console.log(`\n── ${step}\n`, detail)

interface AlphaAccounts {
  pds: string
  accounts: { username: string; password: string }[]
}

async function main() {
  const cfg = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8')) as AlphaAccounts
  const pdsUrl = `https://${cfg.pds}`
  const account = cfg.accounts[0]
  if (!account) throw new Error('no accounts in alpha-users.json')

  // The authority key. In production this is the Stratos service signing key.
  const authorityKey = await Secp256k1Keypair.create({ exportable: true })
  const publicKeyMultibase = authorityKey.did().slice('did:key:'.length)

  let didDoc: unknown
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
    server.listen(DID_DOC_PORT, '127.0.0.1', resolve),
  )

  const listener = await ngrok.forward({
    addr: DID_DOC_PORT,
    authtoken: process.env.NGROK_AUTHTOKEN,
    domain: process.env.NGROK_SERVICE_DOMAIN,
  })
  const tunnelUrl = listener.url()
  if (!tunnelUrl) throw new Error('ngrok gave no URL')
  const authorityHost = new URL(tunnelUrl).host
  const AUTHORITY_DID = `did:web:${authorityHost}`

  didDoc = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: AUTHORITY_DID,
    verificationMethod: [
      {
        id: `${AUTHORITY_DID}#atproto_pns`,
        type: 'Multikey',
        controller: AUTHORITY_DID,
        publicKeyMultibase,
      },
      {
        id: `${AUTHORITY_DID}#atproto`,
        type: 'Multikey',
        controller: AUTHORITY_DID,
        publicKeyMultibase,
      },
    ],
    service: [
      { id: '#stratos', type: 'StratosService', serviceEndpoint: tunnelUrl },
    ],
  }
  log('authority exposed', { AUTHORITY_DID, alg: authorityKey.jwtAlg })

  const spaceUri = `at://${AUTHORITY_DID}/space/${SPACE_TYPE}/${SPACE_SKEY}`

  try {
    // 1. Session on the member's own PDS. A password session is not an OAuth
    //    credential, so assertSpaceScope short-circuits (space/util.ts:93).
    const sessionRes = await fetch(
      `${pdsUrl}/xrpc/com.atproto.server.createSession`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: account.username,
          password: account.password,
        }),
      },
    )
    const session = (await sessionRes.json()) as {
      did?: string
      accessJwt?: string
      error?: string
      message?: string
    }
    if (!sessionRes.ok || !session.accessJwt || !session.did) {
      log('session failed', { status: sessionRes.status, body: session })
      throw new Error('could not authenticate to the alpha PDS')
    }
    const memberDid = session.did
    log('session established', { handle: account.username, did: memberDid })

    // 2. Write into the member's OWN repo, in the Stratos-owned space.
    const rkey = `spike${Date.now()}`
    const writeRes = await fetch(
      `${pdsUrl}/xrpc/com.atproto.space.createRecord`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.accessJwt}`,
        },
        body: JSON.stringify({
          space: spaceUri,
          repo: memberDid,
          collection: COLLECTION,
          rkey,
          validate: false,
          record: {
            $type: COLLECTION,
            text: 'mixed-mode spike: written to the member PDS',
            createdAt: new Date().toISOString(),
          },
        }),
      },
    )
    const written = await writeRes.json()
    log('space createRecord on the member PDS', {
      status: writeRes.status,
      body: written,
    })
    if (!writeRes.ok) throw new Error('write to the member repo failed')

    // 3. Read it back as the SYNCER, holding only an authority-minted
    //    credential. This is the feedgen's position.
    const dpopKey = await JoseKey.generate(['ES256'])
    const jkt = await dpopThumbprint(dpopKey)
    const { credential } = await mintSpaceCredential({
      signingKey: authorityKey,
      issuerDid: AUTHORITY_DID,
      spaceUri,
      ttlSeconds: 300,
      jkt,
    })

    const opsUrl = new URL(`${pdsUrl}/xrpc/com.atproto.space.listRepoOps`)
    opsUrl.searchParams.set('space', spaceUri)
    opsUrl.searchParams.set('repo', memberDid)
    const opsRes = await fetch(opsUrl, {
      headers: {
        authorization: `DPoP ${credential}`,
        dpop: await createDpopProof(dpopKey, {
          htm: 'GET',
          htu: opsUrl.toString(),
          credential,
        }),
      },
    })
    const ops = await opsRes.json()
    log('listRepoOps as the syncer', { status: opsRes.status, body: ops })

    const getUrl = new URL(`${pdsUrl}/xrpc/com.atproto.space.getRecord`)
    getUrl.searchParams.set('space', spaceUri)
    getUrl.searchParams.set('repo', memberDid)
    getUrl.searchParams.set('collection', COLLECTION)
    getUrl.searchParams.set('rkey', rkey)
    const getRes = await fetch(getUrl, {
      headers: {
        authorization: `DPoP ${credential}`,
        dpop: await createDpopProof(dpopKey, {
          htm: 'GET',
          htu: getUrl.toString(),
          credential,
        }),
      },
    })
    const got = await getRes.json()
    log('getRecord as the syncer', { status: getRes.status, body: got })

    const pass = opsRes.ok && getRes.ok
    console.log(`\n${'='.repeat(60)}`)
    console.log(
      pass
        ? 'RESULT: PASS — the syncer read a member repo it does not host.'
        : 'RESULT: FAIL — see the steps above.',
    )
    console.log('='.repeat(60))
    if (!pass) process.exitCode = 1
  } finally {
    await listener.close().catch(() => {})
    server.close()
  }
}

async function dpopThumbprint(key: JoseKey): Promise<string> {
  const jwk = key.bareJwk
  if (!jwk) throw new Error('DPoP key has no public JWK')
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  })
  return createHash('sha256').update(canonical).digest('base64url')
}

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
