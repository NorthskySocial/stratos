import { describe, expect, it } from 'vitest'
import { assertCurrentAuthorityDiscovery } from './authority-contract.discovery.mjs'

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

  it('rejects premature standard host discovery', () => {
    const advertised = {
      ...document,
      service: [
        ...document.service,
        {
          id: '#atproto_space_host',
          type: 'AtprotoSpaceHost',
          serviceEndpoint: endpoint,
        },
      ],
    }
    expect(() =>
      assertCurrentAuthorityDiscovery(advertised, authorityDid, endpoint),
    ).toThrow()
  })
})
