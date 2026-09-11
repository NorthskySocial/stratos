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
  it.each([404, 503])(
    'cancels HTTP %i bodies while preserving retry classification',
    async (status) => {
      const cancel = vi.fn()
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(new ReadableStream({ cancel }), { status }),
        )
      const result = createCommitKeyResolver(sourceResolver(), {
        fetch,
      }).resolveAtprotoKey(JULIA_DID)
      if (status === 404)
        await expect(result).rejects.toBeInstanceOf(DidNotFoundError)
      else
        await expect(result).rejects.toMatchObject({
          status: 503,
          code: 'DidWebHttpError',
        })
      await expect.poll(() => cancel.mock.calls.length).toBe(1)
    },
  )

  it('bounds commit-key documents before parsing', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: JULIA_DID, extra: 'あ'.repeat(200_000) }),
        ),
      )
    await expect(
      createCommitKeyResolver(sourceResolver(), { fetch }).resolveAtprotoKey(
        JULIA_DID,
      ),
    ).rejects.toThrow('Response too large')
  })
  it('blocks private commit-key DID hosts', async () => {
    const fetch = vi.fn()
    await expect(
      createCommitKeyResolver(sourceResolver(), { fetch }).resolveAtprotoKey(
        'did:web:127.0.0.1',
      ),
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('protects the socket and rejects redirects for commit-key lookups', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    await expect(
      createCommitKeyResolver(sourceResolver(), { fetch }).resolveAtprotoKey(
        JULIA_DID,
      ),
    ).rejects.toThrow()
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://julia.bebop.test/.well-known/did.json'),
      expect.objectContaining({
        redirect: 'error',
        dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
      }),
    )
  })
  it.each([408, 429, 500, 503])(
    'preserves retryable did:web HTTP %i responses',
    async (status) => {
      const source = sourceResolver()
      const fetch = vi.fn(async () => new Response(null, { status }))
      const resolver = createCommitKeyResolver(source, { fetch })

      const resolution = resolver.resolveAtprotoKey(JULIA_DID)

      await expect(resolution).rejects.toMatchObject({
        name: 'DidWebHttpError',
        code: 'DidWebHttpError',
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

  it('shares the source cache and bypasses it through the refresh method', async () => {
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
    await expect(resolver.refreshAtprotoKey(JULIA_DID)).resolves.toBe(
      rotatedKey.did(),
    )

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://julia.bebop.test/.well-known/did.json',
    )
  })

  it('delegates non-did:web key refreshes to the source refresh path', async () => {
    const didKey = await Secp256k1Keypair.create({ exportable: true })
    const source = sourceResolver()
    source.resolveAtprotoKey.mockResolvedValue(didKey.did())
    const fetch = vi.fn(async () => {
      throw new Error('must not fetch for did:plc')
    })
    const resolver = createCommitKeyResolver(source, { fetch })

    await expect(resolver.refreshAtprotoKey('did:plc:jetblack')).resolves.toBe(
      didKey.did(),
    )

    expect(source.resolveAtprotoKey).toHaveBeenCalledWith(
      'did:plc:jetblack',
      true,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty identifier', 'did:web:', PoorlyFormattedDidError],
    [
      'a malformed percent escape',
      'did:web:julia.bebop.test%',
      PoorlyFormattedDidError,
    ],
    [
      'a public host with a custom port',
      'did:web:julia.bebop.test%3A8443',
      PoorlyFormattedDidError,
    ],
    [
      'a public host with an explicit default port',
      'did:web:julia.bebop.test%3A443',
      PoorlyFormattedDidError,
    ],
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
