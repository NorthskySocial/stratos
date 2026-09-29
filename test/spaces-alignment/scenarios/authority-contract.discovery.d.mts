export interface AuthorityDidDocument {
  id: string
  verificationMethod: {
    id: string
    controller: string
    type: string
    publicKeyMultibase: string
  }[]
  service: {
    id: string
    type: string
    serviceEndpoint: string
  }[]
}

export function assertCurrentAuthorityDiscovery(
  document: AuthorityDidDocument,
  authorityDid: string,
  endpoint: string,
): void
