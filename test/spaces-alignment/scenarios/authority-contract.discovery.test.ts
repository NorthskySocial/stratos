import { describe, expect, it } from 'vitest'
import {
  assertCurrentAuthorityDiscovery,
  assertStandardRouteUnsupported,
  didWebDocumentUrl,
  writerSigningKeyMultibase,
} from './authority-contract.discovery.mjs'

const authorityDid = 'did:web:stratos-e2e.atmosbox.test'
const endpoint = 'https://stratos-e2e.atmosbox.internal'
const document = {
  id: authorityDid,
  verificationMethod: [
    {
      id: `${authorityDid}#atproto`,
      controller: authorityDid,
      type: 'Multikey',
      publicKeyMultibase: 'zQ3shokFGDBuuNroGyQvxRbq8pQeP',
    },
  ],
  service: [
    { id: '#stratos', type: 'StratosService', serviceEndpoint: endpoint },
  ],
}

describe('authority did:web resolution', () => {
  it('fetches the DID host rather than the internal OAuth endpoint', () => {
    expect(didWebDocumentUrl(authorityDid).href).toBe(
      'https://stratos-e2e.atmosbox.test/.well-known/did.json',
    )
    expect(didWebDocumentUrl(authorityDid).origin).not.toBe(endpoint)
  })

  it('rejects a non-host DID before constructing an HTTPS URL', () => {
    expect(() => didWebDocumentUrl('did:plc:motokokusangai00000000')).toThrow()
    expect(() =>
      didWebDocumentUrl('did:web:stratos-e2e.atmosbox.test%3A443'),
    ).toThrow()
    expect(() =>
      didWebDocumentUrl('did:web:stratos-e2e.atmosbox.test/other'),
    ).toThrow()
  })
})

describe('current authority DID discovery', () => {
  it('accepts the fallback signing key without a dedicated space key or host', () => {
    expect(() =>
      assertCurrentAuthorityDiscovery(document, authorityDid, endpoint),
    ).not.toThrow()
  })

  it('rejects a document that has no usable fallback signing key', () => {
    const wrongKey = {
      ...document,
      verificationMethod: [
        {
          ...document.verificationMethod[0],
          id: `${authorityDid}#atproto_space`,
        },
      ],
    }
    expect(() =>
      assertCurrentAuthorityDiscovery(wrongKey, authorityDid, endpoint),
    ).toThrow()
  })

  it('does not substitute another verification method for the fallback key', () => {
    const impostor = {
      ...document.verificationMethod[0],
      id: `${authorityDid}#other`,
    }
    expect(() =>
      assertCurrentAuthorityDiscovery(
        { ...document, verificationMethod: [impostor] },
        authorityDid,
        endpoint,
      ),
    ).toThrow()
    expect(() =>
      assertCurrentAuthorityDiscovery(
        {
          ...document,
          service: [{ ...document.service[0], id: '#other' }],
        },
        authorityDid,
        endpoint,
      ),
    ).toThrow()
  })

  it('requires a complete multibase value for the fallback key', () => {
    for (const value of ['prefixzQ3shok', 'zQ3shok-suffix']) {
      expect(() =>
        assertCurrentAuthorityDiscovery(
          {
            ...document,
            verificationMethod: [
              { ...document.verificationMethod[0], publicKeyMultibase: value },
            ],
          },
          authorityDid,
          endpoint,
        ),
      ).toThrow()
    }
  })

  it('rejects a dedicated space key even when the fallback key remains', () => {
    for (const id of ['#atproto_space', `${authorityDid}#atproto_space`]) {
      expect(() =>
        assertCurrentAuthorityDiscovery(
          {
            ...document,
            verificationMethod: [
              ...document.verificationMethod,
              { ...document.verificationMethod[0], id },
            ],
          },
          authorityDid,
          endpoint,
        ),
      ).toThrow()
    }
  })

  it('rejects premature standard host discovery', () => {
    for (const id of [
      '#atproto_space_host',
      `${authorityDid}#atproto_space_host`,
    ]) {
      const advertised = {
        ...document,
        service: [
          ...document.service,
          { id, type: 'AtprotoSpaceHost', serviceEndpoint: endpoint },
        ],
      }
      expect(() =>
        assertCurrentAuthorityDiscovery(advertised, authorityDid, endpoint),
      ).toThrow()
    }
  })

  it('rejects the PDS service that standard host discovery would fall back to', () => {
    for (const id of ['#atproto_pds', `${authorityDid}#atproto_pds`]) {
      const advertised = {
        ...document,
        service: [
          ...document.service,
          {
            id,
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: endpoint,
          },
        ],
      }
      expect(() =>
        assertCurrentAuthorityDiscovery(advertised, authorityDid, endpoint),
      ).toThrow()
    }
  })
})

describe('writer signed-head key selection', () => {
  const writerDid = 'did:plc:motokokusangai00000000'
  const key = {
    id: `${writerDid}#atproto`,
    controller: writerDid,
    type: 'Multikey',
    publicKeyMultibase: 'zQ3shokFGDBuuNroGyQvxRbq8pQeP',
  }

  it('selects the account key bound to the requested writer DID', () => {
    expect(
      writerSigningKeyMultibase(
        { id: writerDid, verificationMethod: [key] },
        writerDid,
      ),
    ).toBe(key.publicKeyMultibase)
  })

  it('rejects a foreign key whose id merely ends in #atproto', () => {
    expect(() =>
      writerSigningKeyMultibase(
        {
          id: writerDid,
          verificationMethod: [
            { ...key, id: 'did:plc:asukalangley0000000000#atproto' },
          ],
        },
        writerDid,
      ),
    ).toThrow()
  })

  it('rejects a key controlled by another DID or in another DID document', () => {
    expect(() =>
      writerSigningKeyMultibase(
        {
          id: writerDid,
          verificationMethod: [
            { ...key, controller: 'did:plc:asukalangley0000000000' },
          ],
        },
        writerDid,
      ),
    ).toThrow()
    expect(() =>
      writerSigningKeyMultibase(
        { id: 'did:plc:asukalangley0000000000', verificationMethod: [key] },
        writerDid,
      ),
    ).toThrow()
  })

  it('requires a complete multibase value for the writer key', () => {
    for (const value of ['prefixzQ3shok', 'zQ3shok-suffix']) {
      expect(() =>
        writerSigningKeyMultibase(
          {
            id: writerDid,
            verificationMethod: [{ ...key, publicKeyMultibase: value }],
          },
          writerDid,
        ),
      ).toThrow()
    }
  })
})

describe('unimplemented standard XRPC methods', () => {
  it('accepts the XRPC server unknown-method response', async () => {
    const response = Response.json(
      { error: 'MethodNotImplemented', message: 'Method Not Implemented' },
      { status: 501 },
    )
    await expect(
      assertStandardRouteUnsupported(response, 'getSpaceCredential'),
    ).resolves.toBeUndefined()
  })

  it('rejects a generic 404, success, or unrelated server error', async () => {
    for (const [status, error] of [
      [404, 'NotFound'],
      [200, 'MethodNotImplemented'],
      [501, 'InternalServerError'],
    ] as const) {
      const response = Response.json({ error }, { status })
      await expect(
        assertStandardRouteUnsupported(response, 'listRepos'),
      ).rejects.toThrow()
    }
    await expect(
      assertStandardRouteUnsupported(
        new Response('gateway error', { status: 501 }),
        'registerNotify',
      ),
    ).rejects.toThrow()
    await expect(
      assertStandardRouteUnsupported(
        new Response('{"error":"MethodNotImplemented"}', {
          status: 501,
          headers: { 'content-type': 'text/application/json' },
        }),
        'unregisterNotify',
      ),
    ).rejects.toThrow()
  })
})
