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
  assert.equal(signingKey?.controller, authorityDid)
  assert.equal(signingKey?.type, 'Multikey')
  assert.match(signingKey?.publicKeyMultibase ?? '', /^z[1-9A-HJ-NP-Za-km-z]+$/)

  assert.ok(Array.isArray(document.service))
  const stratosService = document.service.find(
    (service) => service.id === '#stratos',
  )
  assert.equal(stratosService?.type, 'StratosService')
  assert.equal(stratosService?.serviceEndpoint, endpoint)
  assert.ok(
    document.service.every((service) => service.id !== '#atproto_space_host'),
  )
}
