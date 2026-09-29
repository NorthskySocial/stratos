import assert from 'node:assert/strict'

/** Describe the existing signing identity without advertising a space host. */
export function assertCurrentAuthorityDiscovery(
  document,
  authorityDid,
  endpoint,
) {
  assert.equal(document.id, authorityDid)
  assert.ok(Array.isArray(document.verificationMethod))
  const signingKey = document.verificationMethod.find(
    (method) => method.id === `${authorityDid}#atproto`,
  )
  assert.ok(signingKey, 'Authority DID has no fallback signing key')
  assert.equal(signingKey.controller, authorityDid)
  assert.equal(signingKey.type, 'Multikey')
  assert.match(signingKey.publicKeyMultibase, /^z[1-9A-HJ-NP-Za-km-z]+$/)
  assert.ok(
    document.verificationMethod.every(
      (method) =>
        method.id !== '#atproto_space' &&
        method.id !== `${authorityDid}#atproto_space`,
    ),
  )

  assert.ok(Array.isArray(document.service))
  const stratosService = document.service.find(
    (service) => service.id === '#stratos',
  )
  assert.ok(stratosService, 'Authority DID has no Stratos endpoint')
  assert.equal(stratosService.type, 'StratosService')
  assert.equal(stratosService.serviceEndpoint, endpoint)
  assert.ok(
    document.service.every(
      (service) =>
        service.id !== '#atproto_space_host' &&
        service.id !== `${authorityDid}#atproto_space_host`,
    ),
  )
}

/** Return only the account key belonging to the writer whose head is checked. */
export function writerSigningKeyMultibase(document, writerDid) {
  assert.equal(document.id, writerDid)
  assert.ok(Array.isArray(document.verificationMethod))
  const signingKey = document.verificationMethod.find(
    (method) => method.id === `${writerDid}#atproto`,
  )
  assert.ok(signingKey, 'Writer DID has no account signing key')
  assert.equal(signingKey.controller, writerDid)
  assert.equal(signingKey.type, 'Multikey')
  assert.match(signingKey.publicKeyMultibase, /^z[1-9A-HJ-NP-Za-km-z]+$/)
  return signingKey.publicKeyMultibase
}
