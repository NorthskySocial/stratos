import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('/app/stratos-service/package.json')
const cryptoPath = require.resolve('@atproto/crypto')
const { Secp256k1Keypair } = await import(pathToFileURL(cryptoPath).href)
const { mintSpaceCredential } =
  await import('/app/stratos-service/dist/features/space-credential/minter.js')
const { createServiceDb, closeServiceDb } =
  await import('/app/stratos-service/dist/db/index.js')
const { createSqliteBoundaryStore } =
  await import('/app/stratos-service/dist/features/boundary/store.js')

function presentationKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const { crv, kty, x, y } = publicKey.export({ format: 'jwk' })
  const jwk = { kty, crv, x, y }
  const jkt = createHash('sha256')
    .update(JSON.stringify({ crv, kty, x, y }))
    .digest('base64url')
  return { privateKey, jwk, jkt }
}

function proof(key, url, credential) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk }
  const claims = {
    htm: 'GET',
    htu: url.origin + url.pathname,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ath: createHash('sha256').update(credential).digest('base64url'),
  }
  const input = `${encode(header)}.${encode(claims)}`
  const signature = sign('sha256', Buffer.from(input), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${input}.${signature.toString('base64url')}`
}

async function readStatus(url, credential, key) {
  const response = await fetch(url, {
    headers: {
      authorization: `DPoP ${credential}`,
      dpop: proof(key, url, credential),
    },
  })
  return response.status
}

async function main() {
  const domain = process.env.SANDBOX_DOMAIN
  assert.match(domain ?? '', /^[a-z0-9.-]+$/)
  const issuerDid = `did:web:stratos-e2e.${domain}`
  const spaceUri = `at://${issuerDid}/space/zone.stratos.space.feed/general`
  const boundary = `${issuerDid}/general`
  const url = new URL(
    '/xrpc/zone.stratos.space.listRepos',
    'https://stratos-e2e.atmosbox.internal',
  )
  url.searchParams.set('space', spaceUri)

  // The authority key remains in this disposable Stratos container. The host
  // sees only assertion IDs, never private material or signed credentials.
  const stored = JSON.parse(
    await readFile('/app/data/service-signing-identity.json', 'utf8'),
  )
  const signingKey = await Secp256k1Keypair.import(
    Buffer.from(stored.privateKey, 'base64'),
  )
  const db = createServiceDb('/app/data/service.sqlite')
  try {
    const catalog = createSqliteBoundaryStore(db)
    const definition = await catalog.get(boundary)
    assert.equal(definition?.status, 'active')
    const key = presentationKey()
    const common = {
      signingKey,
      issuerDid,
      spaceUri,
      boundaryRevision: definition.revision,
      jkt: key.jkt,
    }
    const expired = await mintSpaceCredential({
      ...common,
      ttlSeconds: 60,
      iat: Math.floor(Date.now() / 1000) - 3_600,
    })
    assert.equal(await readStatus(url, expired.credential, key), 401)
    const passed = ['expired-local-credential-denied']

    const current = await mintSpaceCredential({ ...common, ttlSeconds: 600 })
    assert.equal(await readStatus(url, current.credential, key), 200)
    const settings = {
      displayName: `${definition.displayName} revised`,
      description: definition.description,
      listed: definition.listed,
      joinable: definition.joinable,
      autoEnroll: definition.autoEnroll,
      appAccess: definition.appAccess,
      clientIds: definition.clientIds,
    }
    assert.equal(
      await catalog.update(boundary, settings, definition.revision),
      true,
    )
    assert.equal(await readStatus(url, current.credential, key), 401)
    passed.push('local-revision-denied')

    const revised = await mintSpaceCredential({
      ...common,
      boundaryRevision: definition.revision + 1,
      ttlSeconds: 600,
    })
    assert.equal(await readStatus(url, revised.credential, key), 200)
    assert.equal(
      await catalog.beginDeactivation(boundary, definition.revision + 1),
      true,
    )
    assert.equal(await readStatus(url, revised.credential, key), 401)
    passed.push('local-deactivation-denied')
    console.log(
      JSON.stringify({
        suite: 'credential-lifetime-authority',
        assertions: passed.map((id) => ({ id, status: 'passed' })),
      }),
    )
  } finally {
    await closeServiceDb(db)
  }
}

main().catch((error) => {
  console.error(
    `Credential lifetime authority check failed: ${error instanceof Error ? error.name : 'UnknownError'}`,
  )
  process.exitCode = 1
})
