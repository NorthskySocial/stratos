/**
 * Unit tests for the space-read host-resolution readers, focused on the
 * did:web SSRF guard: resolving a did:web fetches
 * `https://{host}/.well-known/did.json` server-side, and the host comes from
 * the member's own DID, so a private or local host must never reach the
 * resolver.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IdResolver } from '@atproto/identity'
import {
  DidDocumentPdsReader,
  didWebHostname,
  isPrivateOrLocalHost,
} from '../src/features/space-read/host-resolution.js'

const PDS_ENDPOINT = 'https://pds.tokyo3.example.com'

function resolverReturning(doc: unknown): {
  idResolver: IdResolver
  resolve: ReturnType<typeof vi.fn>
} {
  const resolve = vi.fn(async () => doc)
  return { idResolver: { did: { resolve } } as unknown as IdResolver, resolve }
}

const pdsDoc = {
  service: [{ id: '#atproto_pds', serviceEndpoint: PDS_ENDPOINT }],
}

describe('didWebHostname', () => {
  it('extracts the bare authority', () => {
    expect(didWebHostname('did:web:pds.tokyo3.example.com')).toBe(
      'pds.tokyo3.example.com',
    )
  })

  it('strips a percent-encoded port', () => {
    expect(didWebHostname('did:web:pds.tokyo3.example.com%3A8443')).toBe(
      'pds.tokyo3.example.com',
    )
  })

  it('ignores path segments after the authority', () => {
    expect(didWebHostname('did:web:pds.tokyo3.example.com:nerv:magi')).toBe(
      'pds.tokyo3.example.com',
    )
  })

  it('returns undefined for an empty or unparsable authority', () => {
    expect(didWebHostname('did:web:')).toBeUndefined()
    expect(didWebHostname('did:web:%zz')).toBeUndefined()
  })

  it('strips the brackets from an IPv6 authority', () => {
    expect(didWebHostname('did:web:%5B%3A%3A1%5D')).toBe('::1')
  })
})

describe('isPrivateOrLocalHost', () => {
  it.each([
    'localhost',
    'sub.localhost',
    'printer.local',
    'metadata.internal',
    'magi', // single label
    '0.0.0.0',
    '10.0.0.5',
    '100.64.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '100.127.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.1.1',
  ])('rejects %s', (host) => {
    expect(isPrivateOrLocalHost(host)).toBe(true)
  })

  it.each([
    'pds.tokyo3.example.com',
    '8.8.8.8',
    // Each private IPv4 range must reject on BOTH octets, so allow the
    // neighbours that share only one octet with a range.
    '8.16.0.1',
    '8.64.0.1',
    '8.168.0.1',
    '8.254.0.1',
    '100.63.0.1',
    '100.128.0.1',
    '169.253.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '192.167.0.1',
    // A hostname is not an IPv4 literal because it contains one.
    'foo.10.0.0.5',
    '10.0.0.5.example.com',
    '2606:4700::1111',
    // The v6 prefixes must anchor at the start, not match anywhere.
    '2606:4700:fc::1',
    '2606:fe80::1',
    '::ffff:8.8.8.8',
  ])('allows %s', (host) => {
    expect(isPrivateOrLocalHost(host)).toBe(false)
  })
})

describe('DidDocumentPdsReader did:web guard', () => {
  it('never resolves a did:web with a private or local host', async () => {
    const { idResolver, resolve } = resolverReturning(pdsDoc)
    const reader = new DidDocumentPdsReader(idResolver)

    for (const did of [
      'did:web:localhost',
      'did:web:169.254.169.254',
      'did:web:10.0.0.5%3A8080',
      'did:web:magi',
      'did:web:',
    ]) {
      await expect(reader.getPdsEndpoint(did)).resolves.toBeUndefined()
    }
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves a did:web with a public host', async () => {
    const { idResolver, resolve } = resolverReturning(pdsDoc)
    const reader = new DidDocumentPdsReader(idResolver)

    await expect(
      reader.getPdsEndpoint('did:web:pds.tokyo3.example.com'),
    ).resolves.toBe(PDS_ENDPOINT)
    expect(resolve).toHaveBeenCalledWith('did:web:pds.tokyo3.example.com')
  })

  it('leaves non-did:web methods to the resolver', async () => {
    const { idResolver, resolve } = resolverReturning(pdsDoc)
    const reader = new DidDocumentPdsReader(idResolver)

    await expect(reader.getPdsEndpoint('did:plc:asuka')).resolves.toBe(
      PDS_ENDPOINT,
    )
    expect(resolve).toHaveBeenCalledWith('did:plc:asuka')
  })
})
