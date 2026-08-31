import { describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import {
  DidNotFoundError,
  MemoryCache,
  PoorlyFormattedDidDocumentError,
  PoorlyFormattedDidError,
  UnsupportedDidWebPathError,
} from '@atproto/identity'

import {
  createCommitKeyResolver,
  type CommitKeyResolverSource,
} from '../src/space-sync/commit-key-resolver.js'

const JULIA_DID = 'did:web:julia.bebop.test'

function sourceResolver(): CommitKeyResolverSource & {
  resolveAtprotoKey: ReturnType<typeof vi.fn>
} {
  return {
    cache: new MemoryCache(60_000, 120_000),
    resolveAtprotoKey: vi.fn(async () => {
      throw new Error('did:web resolution must not use the fallback resolver')
    }),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function didDocument(did: string, didKey: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: didKey.slice('did:key:'.length),
      },
    ],
  }
}

describe('createCommitKeyResolver', () => {
  it.each([408, 429, 500, 503])(
    'preserves retryable did:web HTTP %i responses',
    async (status) => {
      const source = sourceResolver()
      const fetch = vi.fn(async () => new Response(null, { status }))
      const resolver = createCommitKeyResolver(source, { fetch })

      const resolution = resolver.resolveAtprotoKey(JULIA_DID)

      await expect(resolution).rejects.toMatchObject({
        name: 'DidWebHttpError',
        status,
      })
      expect(source.resolveAtprotoKey).not.toHaveBeenCalled()
    },
  )

  it('keeps a true did:web 404 as a permanent not-found result', async () => {
    const source = sourceResolver()
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    const resolver = createCommitKeyResolver(source, { fetch })

    const resolution = resolver.resolveAtprotoKey(JULIA_DID)

    await expect(resolution).rejects.toBeInstanceOf(DidNotFoundError)
  })

  it('keeps a malformed did:web document as a permanent format error', async () => {
    const source = sourceResolver()
    const fetch = vi.fn(async () =>
      jsonResponse({ id: 'not-the-requested-did' }),
    )
    const resolver = createCommitKeyResolver(source, { fetch })

    const resolution = resolver.resolveAtprotoKey(JULIA_DID)

    await expect(resolution).rejects.toBeInstanceOf(
      PoorlyFormattedDidDocumentError,
    )
  })

  it('shares the source cache and bypasses it on a forced key refresh', async () => {
    const source = sourceResolver()
    const previousKey = await Secp256k1Keypair.create({ exportable: true })
    const rotatedKey = await Secp256k1Keypair.create({ exportable: true })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(didDocument(JULIA_DID, previousKey.did())),
      )
      .mockResolvedValueOnce(
        jsonResponse(didDocument(JULIA_DID, rotatedKey.did())),
      )
    const resolver = createCommitKeyResolver(source, { fetch })

    await expect(resolver.resolveAtprotoKey(JULIA_DID)).resolves.toBe(
      previousKey.did(),
    )
    await expect(resolver.resolveAtprotoKey(JULIA_DID)).resolves.toBe(
      previousKey.did(),
    )
    await expect(resolver.resolveAtprotoKey(JULIA_DID, true)).resolves.toBe(
      rotatedKey.did(),
    )

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://julia.bebop.test/.well-known/did.json',
    )
  })

  it('delegates non-did:web keys and the force-refresh request unchanged', async () => {
    const didKey = await Secp256k1Keypair.create({ exportable: true })
    const source = sourceResolver()
    source.resolveAtprotoKey.mockResolvedValue(didKey.did())
    const fetch = vi.fn(async () => {
      throw new Error('must not fetch for did:plc')
    })
    const resolver = createCommitKeyResolver(source, { fetch })

    await expect(
      resolver.resolveAtprotoKey('did:plc:jetblack', true),
    ).resolves.toBe(didKey.did())

    expect(source.resolveAtprotoKey).toHaveBeenCalledWith(
      'did:plc:jetblack',
      true,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty identifier', 'did:web:', PoorlyFormattedDidError],
    [
      'a path identifier',
      'did:web:julia.bebop.test:crew',
      UnsupportedDidWebPathError,
    ],
  ])('rejects %s without fetching', async (_label, did, ErrorType) => {
    const source = sourceResolver()
    const fetch = vi.fn(async () => jsonResponse({}))
    const resolver = createCommitKeyResolver(source, { fetch })

    const resolution = resolver.resolveAtprotoKey(did)

    await expect(resolution).rejects.toBeInstanceOf(ErrorType)
    expect(fetch).not.toHaveBeenCalled()
  })
})
