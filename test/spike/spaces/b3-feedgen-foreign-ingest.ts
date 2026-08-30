/**
 * Spike B3 — the feed generator syncs a foreign spaces repo into its own index,
 * alongside a Stratos-custody post, and serves them as one boundary feed.
 *
 * This is the mixed-mode proof from the syncer's seat. The feedgen holds only a
 * credential the Stratos authority minted; the record it ingests lives on a PDS
 * the feedgen does not control.
 *
 * It also demonstrates the boundary rule that spike A6 forced. A repo host does
 * not authorize writes against the space authority, so the boundary on a spaces
 * record is a user-supplied claim. The ingest below therefore takes the
 * boundary from Stratos's member state and IGNORES any boundary on the record.
 * Contrast `stratos-feedgen/src/subscription/indexer.ts:47`, which reads the
 * boundary out of the record — correct today, unsafe for a spaces user.
 *
 * Run from stratos-feedgen: pnpm exec tsx ../test/spike/spaces/b3-feedgen-foreign-ingest.ts
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as loadEnv } from 'dotenv'
import ngrok from '@ngrok/ngrok'
import { webcrypto } from 'node:crypto'
import { Secp256k1Keypair } from '@atproto/crypto'
import {
  createSqliteDb,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../../../stratos-feedgen/src/db/sqlite.js'

const REPO_ROOT = new URL('../../../', import.meta.url).pathname
const ACCOUNTS_PATH = `${REPO_ROOT}../ops/alpha-users.json`
const DID_DOC_PORT = 3500
const SPACE_TYPE = 'zone.stratos.space.feed'
const SPACE_SKEY = 'spike'
const COLLECTION = 'zone.stratos.feed.post'

/**
 * The boundary Stratos has assigned this member. In production this comes from
 * the enrollment/boundary store, which is the ONLY authority for it.
 */
const STRATOS_ASSIGNED_BOUNDARY = 'did:web:stratos.test/engineering'

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
  const AUTHORITY_DID = `did:web:${new URL(tunnelUrl).host}`
  didDoc = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: AUTHORITY_DID,
    verificationMethod: [
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
  const spaceUri = `at://${AUTHORITY_DID}/space/${SPACE_TYPE}/${SPACE_SKEY}`
  log('authority exposed', { AUTHORITY_DID })

  const dir = mkdtempSync(join(tmpdir(), 'feedgen-spike-'))
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  const store = new SqliteFeedgenStore(db)

  try {
    // 1. A spaces user writes into their OWN PDS, claiming a boundary they were
    //    never granted. The host accepts it — see spike A6.
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
    }
    if (!session.accessJwt || !session.did) {
      throw new Error('could not authenticate to the alpha PDS')
    }
    const memberDid = session.did

    const rkey = `b3spike${Date.now()}`
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
            text: 'posted from a spaces PDS',
            createdAt: new Date().toISOString(),
            // A boundary the member is NOT entitled to. The ingest must drop it.
            boundaries: ['did:web:stratos.test/leadership'],
          },
        }),
      },
    )
    if (!writeRes.ok) {
      log('write failed', await writeRes.json())
      throw new Error('spaces write failed')
    }
    log('spaces user wrote to their own PDS', {
      memberDid,
      claimedBoundary: 'did:web:stratos.test/leadership',
    })

    // 2. The feedgen, as syncer, pulls that repo with an authority credential.
    const dpopKey = await generateDpopKey()
    const jkt = dpopThumbprint(dpopKey)
    const credential = await mintCredential(
      authorityKey,
      AUTHORITY_DID,
      spaceUri,
      jkt,
    )

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
    // The op shape is {rev, collection, rkey, cid, prev, value?}. `cid` is null
    // for a delete. `value` carries the record inline for creates and updates,
    // so a separate getRecord call is only needed when it is absent.
    const opsBody = (await opsRes.json()) as {
      ops?: {
        rev: string
        collection: string
        rkey: string
        cid: string | null
        prev: string | null
        value?: Record<string, unknown>
      }[]
      commit?: { rev?: string }
    }
    log('listRepoOps', {
      status: opsRes.status,
      opCount: opsBody.ops?.length,
      rev: opsBody.commit?.rev,
      inlineValues: opsBody.ops?.filter((o) => o.value !== undefined).length,
    })

    // 3. Index. Boundary comes from Stratos state, not the record.
    let ingested = 0
    let hydrated = 0
    for (const op of opsBody.ops ?? []) {
      if (op.collection !== COLLECTION) continue
      if (op.cid === null) continue // delete

      let value = op.value
      if (!value) {
        const getUrl = new URL(`${pdsUrl}/xrpc/com.atproto.space.getRecord`)
        getUrl.searchParams.set('space', spaceUri)
        getUrl.searchParams.set('repo', memberDid)
        getUrl.searchParams.set('collection', op.collection)
        getUrl.searchParams.set('rkey', op.rkey)
        const recRes = await fetch(getUrl, {
          headers: {
            authorization: `DPoP ${credential}`,
            dpop: await createDpopProof(dpopKey, {
              htm: 'GET',
              htu: getUrl.toString(),
              credential,
            }),
          },
        })
        if (!recRes.ok) continue
        value = ((await recRes.json()) as { value: Record<string, unknown> })
          .value
        hydrated += 1
      }

      const createdAt =
        typeof value.createdAt === 'string'
          ? value.createdAt
          : new Date().toISOString()

      await store.upsertPost({
        uri: `${spaceUri}/${memberDid}/${op.collection}/${op.rkey}`,
        did: memberDid,
        cid: op.cid,
        sortAt: createdAt,
        indexedAt: new Date().toISOString(),
        record: value,
        blobRefs: [],
        // THE RULE: Stratos decides the boundary. The record does not.
        boundaries: [STRATOS_ASSIGNED_BOUNDARY],
      })
      ingested += 1
    }
    log('ingested from the foreign host', {
      ingested,
      hydratedSeparately: hydrated,
    })

    // 4. A Stratos-custody post, indexed the way the feedgen does today.
    const custodyUri = `at://did:plc:stratoscustodyuser/${COLLECTION}/local1`
    await store.upsertPost({
      uri: custodyUri,
      did: 'did:plc:stratoscustodyuser',
      cid: 'bafyreiacustodyplaceholdercidvalueforspikeonlyxxxxxxxxxxxxx',
      sortAt: new Date(Date.now() - 60_000).toISOString(),
      indexedAt: new Date().toISOString(),
      record: {
        $type: COLLECTION,
        text: 'posted from Stratos custody',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
      blobRefs: [],
      boundaries: [STRATOS_ASSIGNED_BOUNDARY],
    })

    // 5. One boundary feed, both custody classes.
    const feed = await store.listPostsByBoundary({
      boundary: STRATOS_ASSIGNED_BOUNDARY,
      limit: 20,
    })
    log('boundary feed', {
      boundary: STRATOS_ASSIGNED_BOUNDARY,
      posts: feed.posts.map((p) => ({
        did: p.did,
        text: (p.record as { text?: string }).text,
      })),
    })

    // The claimed boundary must not have been honoured.
    const leaked = await store.listPostsByBoundary({
      boundary: 'did:web:stratos.test/leadership',
      limit: 20,
    })

    // The member repo persists on the public PDS between runs, so assert on
    // custody classes present rather than on an exact count.
    const spacesPosts = feed.posts.filter((p) => p.did === memberDid).length
    const custodyPosts = feed.posts.filter(
      (p) => p.did === 'did:plc:stratoscustodyuser',
    ).length
    const ownRecordIndexed = feed.posts.some((p) => p.uri.endsWith(`/${rkey}`))
    const bothPresent = spacesPosts > 0 && custodyPosts > 0 && ownRecordIndexed
    const noLeak = leaked.posts.length === 0
    console.log(`\n${'='.repeat(60)}`)
    console.log(
      `mixed feed: ${spacesPosts} spaces-PDS post(s), ${custodyPosts} Stratos-custody post(s)`,
    )
    console.log(`this run's own record indexed: ${ownRecordIndexed}`)
    console.log(`claimed-but-ungranted boundary was dropped: ${noLeak}`)
    console.log(
      bothPresent && noLeak
        ? 'RESULT: PASS — foreign ingest works and the boundary claim was ignored.'
        : 'RESULT: FAIL — see above.',
    )
    console.log('='.repeat(60))
    if (!bothPresent || !noLeak) process.exitCode = 1
  } finally {
    await listener.close().catch(() => {})
    server.close()
  }
}

async function mintCredential(
  key: Secp256k1Keypair,
  iss: string,
  sub: string,
  jkt: string,
): Promise<string> {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url')
  const iat = Math.floor(Date.now() / 1000)
  const header = {
    typ: 'atproto-space-credential+jwt',
    alg: key.jwtAlg,
    kid: '#atproto',
  }
  const payload = {
    iss,
    sub,
    iat,
    exp: iat + 300,
    jti: randomBytes(16).toString('hex'),
    cnf: { jkt },
  }
  const signingInput = `${b64(header)}.${b64(payload)}`
  const sig = await key.sign(new TextEncoder().encode(signingInput))
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`
}

/** An ES256 DPoP key made with webcrypto, so the feedgen needs no JOSE dep. */
interface DpopKey {
  privateKey: webcrypto.CryptoKey
  jwk: { crv: string; kty: string; x: string; y: string }
}

async function generateDpopKey(): Promise<DpopKey> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const pub = (await webcrypto.subtle.exportKey('jwk', pair.publicKey)) as {
    crv: string
    kty: string
    x: string
    y: string
  }
  return {
    privateKey: pair.privateKey,
    jwk: { crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y },
  }
}

/** RFC 7638 thumbprint. Member order is canonical for an EC key. */
function dpopThumbprint(key: DpopKey): string {
  const canonical = JSON.stringify({
    crv: key.jwk.crv,
    kty: key.jwk.kty,
    x: key.jwk.x,
    y: key.jwk.y,
  })
  return createHash('sha256').update(canonical).digest('base64url')
}

async function createDpopProof(
  key: DpopKey,
  opts: { htm: string; htu: string; credential?: string },
): Promise<string> {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url')
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
  const signingInput = `${b64({ alg: 'ES256', typ: 'dpop+jwt', jwk: key.jwk })}.${b64(claims)}`
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`
}

main().catch((err) => {
  console.error('spike failed:', err)
  process.exitCode = 1
})
