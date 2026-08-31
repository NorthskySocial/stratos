import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import {
  DidNotFoundError,
  PoorlyFormattedDidDocumentError,
  PoorlyFormattedDidError,
  UnsupportedDidMethodError,
  UnsupportedDidWebPathError,
} from '@atproto/identity'
import { expand as hkdfExpand } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import {
  CommitVerifier,
  type CommitVerifierDeps,
} from '../src/space-sync/commit-verify.js'

// 90s-anime crew DIDs and space, matching the space-sync test fixtures.
const SPACE_URI =
  'at://did:web:stratos.test/space/zone.stratos.space.feed/bebop-crew'
const SPIKE_DID = 'did:plc:spikespiegel'
const REV = '3juwxyz'

/**
 * A from-scratch reimplementation of upstream's `RepoCommit.sign`
 * (`packages/space/src/repo-commit.ts` at
 * `permissioned-data@89deb9faca20e56fa2a262fe9746ed52bc1095ba`), used only
 * to build test fixtures. There is no published signer to import — the
 * source it mirrors is cited in `commit-verify.ts` itself.
 */
const DOMAIN_PREFIX = new TextEncoder().encode('atproto-space-v1')

function testEncodeCommitCtx(
  space: string,
  author: string,
  rev: string,
  ikm: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder()
  const fields = [
    encoder.encode(space),
    encoder.encode(author),
    encoder.encode(rev),
    ikm,
  ]
  let size = DOMAIN_PREFIX.length
  for (const field of fields) size += 2 + field.length
  const out = new Uint8Array(size)
  out.set(DOMAIN_PREFIX)
  let offset = DOMAIN_PREFIX.length
  for (const field of fields) {
    out[offset++] = (field.length >>> 8) & 0xff
    out[offset++] = field.length & 0xff
    out.set(field, offset)
    offset += field.length
  }
  return out
}

function bytesField(bytes: Uint8Array): { $bytes: string } {
  return { $bytes: Buffer.from(bytes).toString('base64') }
}

// A well-shaped (not necessarily correctly-signed) commit: every field has
// the right JSON type. Used to isolate one malformed field per test case, so
// each field's own check in `decodeSignedCommit` is what causes the
// rejection, rather than several invalid fields masking each other.
function validCommitFields(): Record<string, unknown> {
  return {
    ver: 1,
    rev: REV,
    hash: bytesField(new Uint8Array(randomBytes(32))),
    ikm: bytesField(new Uint8Array(randomBytes(32))),
    mac: bytesField(new Uint8Array(randomBytes(32))),
    sig: bytesField(new Uint8Array(randomBytes(32))),
  }
}

async function signTestCommit(
  keypair: Secp256k1Keypair,
  overrides: {
    space?: string
    author?: string
    rev?: string
    hash?: Uint8Array
    ikm?: Uint8Array
    ver?: number
  } = {},
): Promise<Record<string, unknown>> {
  const space = overrides.space ?? SPACE_URI
  const author = overrides.author ?? SPIKE_DID
  const rev = overrides.rev ?? REV
  const hash = overrides.hash ?? new Uint8Array(randomBytes(32))
  const ikm = overrides.ikm ?? new Uint8Array(randomBytes(32))
  const ctxBytes = testEncodeCommitCtx(space, author, rev, ikm)
  const prk = hkdfExpand(sha256, ikm, ctxBytes, 32)
  const mac = hmac(sha256, prk, hash)
  const sig = await keypair.sign(ctxBytes)
  return {
    ver: overrides.ver ?? 1,
    rev,
    hash: bytesField(hash),
    ikm: bytesField(ikm),
    mac: bytesField(mac),
    sig: bytesField(sig),
  }
}

function stubResolver(
  resolve: (did: string) => Promise<string>,
): CommitVerifierDeps['didResolver'] {
  return { resolveAtprotoKey: async (did: string) => resolve(did) }
}

function buildVerifier(
  didResolver: CommitVerifierDeps['didResolver'],
): CommitVerifier {
  return new CommitVerifier({ didResolver })
}

describe('CommitVerifier', () => {
  it('accepts a validly signed commit', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair)
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({ ok: true })
  })

  it('rejects a commit with a tampered signature', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair)
    const sig = (commit.sig as { $bytes: string }).$bytes
    const tampered = Buffer.from(sig, 'base64')
    tampered[0] = tampered[0] ^ 0xff
    commit.sig = { $bytes: tampered.toString('base64') }
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'signature-invalid',
      transient: false,
    })
  })

  it('rejects a malformed compact signature without throwing', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair)
    const sig = Buffer.from((commit.sig as { $bytes: string }).$bytes, 'base64')
    commit.sig = bytesField(sig.subarray(0, 63))
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'signature-invalid',
      transient: false,
    })
  })

  it('rejects a commit with a tampered mac', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair)
    const mac = (commit.mac as { $bytes: string }).$bytes
    const tampered = Buffer.from(mac, 'base64')
    tampered[0] = tampered[0] ^ 0xff
    commit.mac = { $bytes: tampered.toString('base64') }
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'mac-mismatch',
      transient: false,
    })
  })

  it('rejects a commit whose mac has a different length than expected', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair)
    // A shorter mac cannot be a bit-flip of the real one — it exercises the
    // length-mismatch guard in `timingSafeEqualBytes` rather than a genuine
    // byte-for-byte comparison. Node's `timingSafeEqual` throws on a length
    // mismatch, so this also proves the guard runs first.
    commit.mac = bytesField(new Uint8Array(randomBytes(16)))
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'mac-mismatch',
      transient: false,
    })
  })

  it('rejects a commit with a tampered rev', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair)
    // `rev` is folded into the signed ctx bytes on both the mac and the
    // signature, so mutating it after signing invalidates the mac first —
    // the verifier never reaches the signature check.
    commit.rev = 'tampered-rev'
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'mac-mismatch',
      transient: false,
    })
  })

  it('rejects a commit signed by a different key', async () => {
    const signingKey = await Secp256k1Keypair.create({ exportable: true })
    const otherKey = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(signingKey)
    const verifier = buildVerifier(stubResolver(async () => otherKey.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'signature-invalid',
      transient: false,
    })
  })

  it('rejects a missing commit', async () => {
    const verifier = buildVerifier(
      stubResolver(async () => {
        throw new Error('must not resolve when there is no commit')
      }),
    )

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, undefined)

    expect(result).toEqual({
      ok: false,
      reason: 'missing-commit',
      transient: false,
    })
  })

  it.each([
    ['empty object', {}],
    ['non-numeric ver', { ver: '1', rev: REV }],
    ['non-string rev', { ver: 1, rev: 42 }],
    ['hash not an object', { ver: 1, rev: REV, hash: 'not-bytes' }],
    ['hash.$bytes not a string', { ver: 1, rev: REV, hash: { $bytes: 123 } }],
    // Each case below leaves every other field well-shaped, so it is that
    // field's own check — not a co-occurring one — that must reject it.
    [
      'ver not a number, other fields valid',
      { ...validCommitFields(), ver: '1' },
    ],
    [
      'rev not a string, other fields valid',
      { ...validCommitFields(), rev: 42 },
    ],
    [
      'hash not bytes, other fields valid',
      { ...validCommitFields(), hash: 'not-bytes' },
    ],
    [
      'hash is null, other fields valid',
      { ...validCommitFields(), hash: null },
    ],
    [
      'ikm not bytes, other fields valid',
      { ...validCommitFields(), ikm: 'not-bytes' },
    ],
    [
      'mac not bytes, other fields valid',
      { ...validCommitFields(), mac: 'not-bytes' },
    ],
    [
      'sig not bytes, other fields valid',
      { ...validCommitFields(), sig: 'not-bytes' },
    ],
  ])('rejects a malformed commit (%s)', async (_label, commit) => {
    const verifier = buildVerifier(
      stubResolver(async () => {
        throw new Error('must not resolve for a malformed commit')
      }),
    )

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'malformed-commit',
      transient: false,
    })
  })

  it('accepts a commit whose rev exactly fills the uint16 length prefix', async () => {
    // 0xffff is the largest value a uint16 length prefix can hold, so a field
    // of exactly that size is legal — only a field larger than it must throw.
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair, { rev: 'r'.repeat(0xffff) })
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({ ok: true })
  })

  it('rejects a commit whose rev cannot be encoded into a bounded ctx field', async () => {
    // `rev` is host-controlled and unbounded. `encodeCommitCtx`'s uint16
    // length prefix throws rather than silently truncate, so a rev this
    // large must surface as a graceful result, not an uncaught exception.
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = { ...validCommitFields(), rev: 'r'.repeat(0x10000) }
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'malformed-commit',
      transient: false,
    })
  })

  it('rejects an unsupported commit version', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair, { ver: 2 })
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'unsupported-version',
      transient: false,
    })
  })

  it.each([
    [
      'a retryable HTTP response',
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
    ],
    [
      'a rate-limited HTTP response',
      Object.assign(new Error('Too Many Requests'), { status: 429 }),
    ],
    ['an aborted request', new DOMException('timed out', 'AbortError')],
    [
      'a nested network error',
      Object.assign(new Error('resolver request failed'), {
        cause: Object.assign(new Error('dns lookup failed'), {
          code: 'ENOTFOUND',
        }),
      }),
    ],
    ['a fetch failure', new TypeError('fetch failed')],
  ])(
    'treats %s as a transient resolver failure',
    async (_label, resolveError) => {
      const keypair = await Secp256k1Keypair.create({ exportable: true })
      const commit = await signTestCommit(keypair)
      const verifier = buildVerifier(
        stubResolver(async () => {
          throw resolveError
        }),
      )

      const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

      expect(result).toEqual({
        ok: false,
        reason: 'key-unresolvable',
        transient: true,
        error: resolveError,
      })
    },
  )

  it.each([
    ['missing DID', new DidNotFoundError(SPIKE_DID)],
    ['malformed DID', new PoorlyFormattedDidError(SPIKE_DID)],
    [
      'malformed DID document',
      new PoorlyFormattedDidDocumentError(SPIKE_DID, {}),
    ],
    ['unsupported DID method', new UnsupportedDidMethodError(SPIKE_DID)],
    ['unsupported did:web path', new UnsupportedDidWebPathError(SPIKE_DID)],
    ['missing atproto key', new Error('Could not parse signingKey from doc')],
    [
      'non-retryable HTTP response',
      Object.assign(new Error('Bad Request'), { status: 400 }),
    ],
  ])(
    'treats %s as a permanent resolver failure',
    async (_label, resolveError) => {
      const keypair = await Secp256k1Keypair.create({ exportable: true })
      const commit = await signTestCommit(keypair)
      const verifier = buildVerifier(
        stubResolver(async () => {
          throw resolveError
        }),
      )

      const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

      expect(result).toEqual({
        ok: false,
        reason: 'key-unresolvable',
        transient: false,
        error: resolveError,
      })
    },
  )

  it('treats malformed resolved key material as non-transient', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const commit = await signTestCommit(keypair)
    const verifier = buildVerifier(
      stubResolver(async () => 'did:key:not-valid'),
    )

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'key-unresolvable',
      transient: false,
    })
  })

  it('binds the space into the signed context, rejecting cross-space replay', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const otherSpace =
      'at://did:web:stratos.test/space/zone.stratos.space.feed/nerv-pilots'
    const commit = await signTestCommit(keypair, { space: otherSpace })
    const verifier = buildVerifier(stubResolver(async () => keypair.did()))

    const result = await verifier.verify(SPACE_URI, SPIKE_DID, commit)

    expect(result).toEqual({
      ok: false,
      reason: 'mac-mismatch',
      transient: false,
    })
  })
})
