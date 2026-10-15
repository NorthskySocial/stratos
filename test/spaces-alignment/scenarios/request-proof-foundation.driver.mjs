import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL(process.env.FOUNDATION_ROOT ?? 'file:///app/')
const require = createRequire(new URL('stratos-service/package.json', root))
const { P256Keypair, verifySignature } = require('@atproto/crypto')
const { createRequestProof, verifyRequestProof, requestProofReplayEntry } =
  await import(new URL('stratos-client/dist/index.js', root))
const { admitClientRequestProof } = await import(
  new URL('stratos-service/dist/infra/auth/request-proof-foundation.js', root)
)
const { ReplayStore } = await import(
  new URL('stratos-service/dist/infra/auth/replay-store.js', root)
)
const { RedisCache } = await import(
  new URL('stratos-service/dist/infra/storage/redis-cache.js', root)
)
const redisUrl =
  process.env.FOUNDATION_REDIS_URL ?? process.env.STRATOS_VALKEY_URL
assert.ok(redisUrl, 'A disposable Redis endpoint is required')

function dependencies(request, cache) {
  return {
    request: { ...request, body: new Uint8Array() },
    async verifyCredential(token) {
      const [header, payload, signature] = token.split('.')
      assert.equal(header, request.credentialHeader)
      assert.equal(
        await verifySignature(
          request.credentialIssuerKey,
          new TextEncoder().encode(`${header}.${payload}`),
          Buffer.from(signature, 'base64url'),
        ),
        true,
      )
      const claims = JSON.parse(Buffer.from(payload, 'base64url'))
      assert.equal(claims.aud, request.authority)
      assert.ok(claims.exp > Date.now() / 1000)
      return { credentialKey: claims.cnf.kid }
    },
    authorize: async () => true,
    replayStore: new ReplayStore(cache),
    nowSeconds: () => Date.now() / 1000,
  }
}

if (process.argv.includes('--worker')) {
  const cache = new RedisCache(redisUrl)
  process.send({ ready: true })
  process.once('message', async ({ request, presentation }) => {
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          admitClientRequestProof(presentation, dependencies(request, cache)),
        ),
      )
      process.send({
        accepted: results.filter((r) => r.status === 'fulfilled').length,
      })
    } finally {
      await cache.close()
      process.disconnect()
    }
  })
} else {
  const cache = new RedisCache(redisUrl)
  const workers = []
  const passed = []
  try {
    const issuer = await P256Keypair.create()
    const key = await P256Keypair.create()
    const signingKey = {
      type: 'p256',
      jwtAlg: 'ES256',
      exportPublicKey: async () => key.did(),
      sign: (input) => key.sign(input),
    }
    const now = Math.floor(Date.now() / 1000)
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString('base64url')
    const credentialHeader = encode({ typ: 'JWT', alg: 'ES256' })
    const authority = 'did:web:nerv.tokyo.jp'
    const payload = encode({
      aud: authority,
      exp: now + 120,
      cnf: { kid: key.did() },
    })
    const input = `${credentialHeader}.${payload}`
    const credential = `${input}.${Buffer.from(await issuer.sign(new TextEncoder().encode(input))).toString('base64url')}`
    const request = {
      credential,
      credentialKey: key.did(),
      authority,
      method: 'GET',
      target: '/xrpc/zone.stratos.space.getRecord?a=%2F&a=rei?',
      body: new Uint8Array(),
      now,
      credentialHeader,
      credentialIssuerKey: issuer.did(),
    }
    const proof = await createRequestProof({ ...request, signingKey })
    const presentation = { credential, proof }
    const deps = dependencies(request, cache)
    await assert.rejects(
      admitClientRequestProof(presentation, {
        ...deps,
        request: {
          ...deps.request,
          target: request.target.replace('%2F', '%2f'),
        },
      }),
    )
    await assert.rejects(
      admitClientRequestProof(presentation, {
        ...deps,
        authorize: async () => false,
      }),
    )
    passed.push('invalid-admission-preserves-proof')
    const tasks = Array.from(
      { length: 2 },
      () =>
        new Promise((resolve, reject) => {
          const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          })
          workers.push(child)
          let accepted
          child.on('error', reject)
          child.on('message', (message) => {
            if (message.ready) child.send({ request, presentation })
            else accepted = message.accepted
          })
          child.on('exit', (code) => {
            if (code !== 0 || !Number.isInteger(accepted))
              reject(new Error('Foundation worker failed'))
            else resolve(accepted)
          })
        }),
    )
    const accepted = await Promise.all(tasks)
    assert.equal(
      accepted.reduce((sum, count) => sum + count, 0),
      1,
    )
    passed.push('distributed-concurrent-single-consume')
    await assert.rejects(admitClientRequestProof(presentation, deps))
    const verified = await verifyRequestProof(proof, request)
    const entry = requestProofReplayEntry(verified, Date.now() / 1000)
    assert.equal(await cache.get(`replay:${entry.kind}:${entry.jti}`), '1')
    const { Redis } = require('ioredis')
    const observer = new Redis(redisUrl)
    try {
      const ttl = await observer.ttl(`replay:${entry.kind}:${entry.jti}`)
      assert.ok(ttl >= entry.ttlSeconds - 1 && ttl <= entry.ttlSeconds)
    } finally {
      await observer.quit()
    }
    passed.push('expiry-plus-skew-retained')
    const fresh = await createRequestProof({ ...request, signingKey })
    assert.notEqual(fresh, proof)
    await admitClientRequestProof({ credential, proof: fresh }, deps)
    passed.push('fresh-proof-retry')
    await assert.rejects(
      admitClientRequestProof(presentation, {
        ...deps,
        replayStore: undefined,
      }),
    )
    const closedCache = new RedisCache(redisUrl)
    await closedCache.close()
    const retry = await createRequestProof({ ...request, signingKey })
    await assert.rejects(
      admitClientRequestProof(
        { credential, proof: retry },
        dependencies(request, closedCache),
      ),
    )
    await admitClientRequestProof({ credential, proof: retry }, deps)
    passed.push('unavailable-storage-fails-closed')
    console.log(
      JSON.stringify({
        suite: 'request-proof-foundation',
        assertions: passed.map((id) => ({ id, status: 'passed' })),
      }),
    )
  } finally {
    await cache.close()
    for (const child of workers) if (child.connected) child.disconnect()
  }
}
