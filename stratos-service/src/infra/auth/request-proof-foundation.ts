import { getDidKeyFromMultibase, type DidDocument } from '@atproto/identity'
import { parseDidKey, verifySignature } from '@atproto/crypto'
import {
  requestProofReplayEntry,
  verifyRequestProof,
  verifyServiceAssertion,
  type RequestProofContext,
  type RequestProofReplayStore,
  type ServiceAssertionKeyResolver,
  type VerifiedRequestProof,
} from '@northskysocial/stratos-client'

export interface AssertionDidResolver {
  resolve(issuer: string, forceRefresh: true): Promise<DidDocument | null>
}

export function serviceAssertionKeyResolver(
  resolver: AssertionDidResolver,
): ServiceAssertionKeyResolver {
  return {
    async resolve(issuer, kid) {
      const document = await resolver.resolve(issuer, true)
      if (!document || document.id !== issuer)
        throw new Error('Authorization failed')
      const methods =
        document.verificationMethod?.filter((method) => method.id === kid) ?? []
      if (methods.length !== 1) throw new Error('Authorization failed')
      const method = methods[0]
      if (method.controller !== issuer || !method.publicKeyMultibase)
        throw new Error('Authorization failed')
      const didKey = getDidKeyFromMultibase({
        type: method.type,
        publicKeyMultibase: method.publicKeyMultibase,
      })
      if (!didKey) throw new Error('Authorization failed')
      const { jwtAlg } = parseDidKey(didKey)
      return {
        type: jwtAlg === 'ES256' ? 'p256' : 'secp256k1',
        jwtAlg,
        verify: (signature, input) =>
          verifySignature(didKey, input, signature, {
            allowMalleableSig: true,
          }),
      }
    },
  }
}

export interface FoundationPresentation {
  credential: string
  proof: string
  assertion?: string
}

export interface FoundationAdmissionDeps {
  request: Omit<RequestProofContext, 'credential' | 'credentialKey' | 'now'>
  verifyCredential(credential: string): Promise<{ credentialKey: string }>
  authorize(
    proof: VerifiedRequestProof,
    service?: { issuer: string; kid: string },
  ): Promise<boolean>
  replayStore: RequestProofReplayStore | undefined
  nowSeconds(): number
}

export interface FoundationServicePolicy {
  issuer: string
  lxm: string
  resolver: ServiceAssertionKeyResolver
}

async function admit(
  presentation: FoundationPresentation,
  deps: FoundationAdmissionDeps,
  policy?: FoundationServicePolicy,
): Promise<VerifiedRequestProof> {
  const { credentialKey } = await deps.verifyCredential(presentation.credential)
  const context: RequestProofContext = {
    ...deps.request,
    credential: presentation.credential,
    credentialKey,
    now: Math.floor(deps.nowSeconds()),
  }
  let proof: VerifiedRequestProof
  let service: { issuer: string; kid: string } | undefined
  if (policy) {
    if (!presentation.assertion) throw new Error('Authorization failed')
    const verified = await verifyServiceAssertion(
      presentation.assertion,
      {
        proof: presentation.proof,
        request: context,
        issuer: policy.issuer,
        lxm: policy.lxm,
      },
      policy.resolver,
    )
    proof = verified.proof
    service = { issuer: verified.issuer, kid: verified.kid }
  } else {
    if (presentation.assertion !== undefined)
      throw new Error('Authorization failed')
    proof = await verifyRequestProof(presentation.proof, context)
  }
  if (!(await deps.authorize(proof, service)))
    throw new Error('Authorization failed')
  const entry = requestProofReplayEntry(proof, deps.nowSeconds())
  if (
    !deps.replayStore ||
    !(await deps.replayStore.consumeOnce(
      entry.kind,
      entry.jti,
      entry.ttlSeconds,
    ))
  )
    throw new Error('Authorization failed')
  return proof
}

export function admitClientRequestProof(
  presentation: FoundationPresentation,
  deps: FoundationAdmissionDeps,
): Promise<VerifiedRequestProof> {
  return admit(presentation, deps)
}

export function admitServiceRequestProof(
  presentation: FoundationPresentation,
  deps: FoundationAdmissionDeps,
  policy: FoundationServicePolicy,
): Promise<VerifiedRequestProof> {
  return admit(presentation, deps, policy)
}
