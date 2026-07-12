/**
 * Unit tests for the external-client JWKS resolver.
 *
 * All fetches are mocked — NO live network. Exercises: HTTPS-only enforcement,
 * inline `jwks` vs fetched `jwks_uri`, TTL caching (hit / expiry), unknown-kid,
 * and fail-closed behaviour on every fetch/parse/shape error.
 */
import { describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair } from 'jose'
import {
  DEFAULT_JWKS_CACHE_TTL_MS,
  JwksResolver,
  MalformedJwksError,
  MetadataFetchError,
  NonHttpsClientIdError,
  UnknownKidError,
} from '../src/infra/auth/jwks-resolver.js'

const CLIENT_ID = 'https://client.example/client-metadata.json'
const KID = 'key-1'

/** Generate an ES256 public JWK tagged with `kid`. */
async function makePublicJwk(kid = KID): Promise<Record<string, unknown>> {
  const { publicKey } = await generateKeyPair('ES256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  return { ...jwk, kid, alg: 'ES256', use: 'sig' }
}

/** A fetch mock returning JSON bodies keyed by URL, or a per-URL error. */
function mockFetch(
  routes: Record<string, unknown | (() => never)>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string) => {
    const url = input.toString()
    const entry = routes[url]
    if (entry === undefined) {
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }
    if (typeof entry === 'function') {
      ;(entry as () => never)()
    }
    return {
      ok: true,
      status: 200,
      json: async () => entry,
    } as Response
  })
}

describe('JwksResolver', () => {
  it('rejects a non-HTTPS client_id WITHOUT fetching', async () => {
    const fetch = vi.fn()
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(
      resolver.resolveJwks('http://client.example/client-metadata.json'),
    ).rejects.toBeInstanceOf(NonHttpsClientIdError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resolves keys from inline `jwks`', async () => {
    const jwk = await makePublicJwk()
    const fetch = mockFetch({ [CLIENT_ID]: { jwks: { keys: [jwk] } } })
    const resolver = new JwksResolver({ fetch: fetch as never })

    const keys = await resolver.resolveJwks(CLIENT_ID)
    expect(keys).toHaveLength(1)
    expect(keys[0].kid).toBe(KID)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves keys from a fetched `jwks_uri` (HTTPS)', async () => {
    const jwk = await makePublicJwk()
    const jwksUri = 'https://client.example/jwks.json'
    const fetch = mockFetch({
      [CLIENT_ID]: { jwks_uri: jwksUri },
      [jwksUri]: { keys: [jwk] },
    })
    const resolver = new JwksResolver({ fetch: fetch as never })

    const keys = await resolver.resolveJwks(CLIENT_ID)
    expect(keys[0].kid).toBe(KID)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-HTTPS jwks_uri', async () => {
    const fetch = mockFetch({
      [CLIENT_ID]: { jwks_uri: 'http://client.example/jwks.json' },
    })
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(resolver.resolveJwks(CLIENT_ID)).rejects.toBeInstanceOf(
      NonHttpsClientIdError,
    )
  })

  it('caches successful resolutions for the TTL (no second fetch)', async () => {
    const jwk = await makePublicJwk()
    const fetch = mockFetch({ [CLIENT_ID]: { jwks: { keys: [jwk] } } })
    let now = 1_000_000
    const resolver = new JwksResolver({
      fetch: fetch as never,
      now: () => now,
    })

    await resolver.resolveJwks(CLIENT_ID)
    now += DEFAULT_JWKS_CACHE_TTL_MS - 1
    await resolver.resolveJwks(CLIENT_ID)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after the TTL expires', async () => {
    const jwk = await makePublicJwk()
    const fetch = mockFetch({ [CLIENT_ID]: { jwks: { keys: [jwk] } } })
    let now = 1_000_000
    const resolver = new JwksResolver({
      fetch: fetch as never,
      now: () => now,
    })

    await resolver.resolveJwks(CLIENT_ID)
    now += DEFAULT_JWKS_CACHE_TTL_MS + 1
    await resolver.resolveJwks(CLIENT_ID)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache failures (a later success resolves)', async () => {
    const jwk = await makePublicJwk()
    let fail = true
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('network down')
      return {
        ok: true,
        status: 200,
        json: async () => ({ jwks: { keys: [jwk] } }),
      } as Response
    })
    const resolver = new JwksResolver({ fetch: fetch as never })

    await expect(resolver.resolveJwks(CLIENT_ID)).rejects.toBeInstanceOf(
      MetadataFetchError,
    )
    fail = false
    const keys = await resolver.resolveJwks(CLIENT_ID)
    expect(keys[0].kid).toBe(KID)
  })

  it('fails closed on a network error (MetadataFetchError)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(resolver.resolveJwks(CLIENT_ID)).rejects.toBeInstanceOf(
      MetadataFetchError,
    )
  })

  it('fails closed on a non-2xx metadata response', async () => {
    const fetch = vi.fn(
      async () =>
        ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    )
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(resolver.resolveJwks(CLIENT_ID)).rejects.toBeInstanceOf(
      MetadataFetchError,
    )
  })

  it('fails closed on metadata missing both jwks and jwks_uri', async () => {
    const fetch = mockFetch({ [CLIENT_ID]: { client_name: 'nope' } })
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(resolver.resolveJwks(CLIENT_ID)).rejects.toBeInstanceOf(
      MalformedJwksError,
    )
  })

  it('fails closed on a JWKS without a keys array', async () => {
    const fetch = mockFetch({ [CLIENT_ID]: { jwks: { notkeys: [] } } })
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(resolver.resolveJwks(CLIENT_ID)).rejects.toBeInstanceOf(
      MalformedJwksError,
    )
  })

  it('fails closed on an empty keys array', async () => {
    const fetch = mockFetch({ [CLIENT_ID]: { jwks: { keys: [] } } })
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(resolver.resolveJwks(CLIENT_ID)).rejects.toBeInstanceOf(
      MalformedJwksError,
    )
  })

  it('resolveKey throws UnknownKidError when no key matches kid', async () => {
    const jwk = await makePublicJwk('other-kid')
    const fetch = mockFetch({ [CLIENT_ID]: { jwks: { keys: [jwk] } } })
    const resolver = new JwksResolver({ fetch: fetch as never })
    await expect(
      resolver.resolveKey(CLIENT_ID, KID, 'ES256'),
    ).rejects.toBeInstanceOf(UnknownKidError)
  })

  it('resolveKey imports the matching key', async () => {
    const jwk = await makePublicJwk()
    const fetch = mockFetch({ [CLIENT_ID]: { jwks: { keys: [jwk] } } })
    const resolver = new JwksResolver({ fetch: fetch as never })
    const key = await resolver.resolveKey(CLIENT_ID, KID, 'ES256')
    expect(key).toBeTruthy()
  })
})
