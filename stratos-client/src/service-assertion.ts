import { type PrivateKey, type PublicKey } from '@atcute/crypto'
import {
  decodeProofBytes,
  decodeProofObject,
  encodeProofBytes,
  proofDigest,
  proofUtf8,
  rejectProof,
} from './request-proof-codec.js'
import {
  verifyRequestProof,
  type RequestProofContext,
  type VerifiedRequestProof,
} from './request-proof.js'

const TYP = 'stratos-service-assertion-v1+jwt'

export interface ServiceAssertionContext {
  proof: string
  request: RequestProofContext
  issuer: string
  lxm: string
}

export interface CreateServiceAssertionOptions extends ServiceAssertionContext {
  kid: string
  signingKey: PrivateKey
}

export interface ServiceAssertionKeyResolver {
  resolve(
    issuer: string,
    kid: string,
  ): Promise<Pick<PublicKey, 'type' | 'jwtAlg' | 'verify'>>
}

export interface VerifiedServiceAssertion {
  readonly issuer: string
  readonly kid: string
  readonly proof: VerifiedRequestProof
}

function boundedAscii(value: unknown, max: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[^\x21-\x7e]/.test(value)
  )
    rejectProof()
}

function validateIdentity(context: ServiceAssertionContext): void {
  boundedAscii(context.issuer, 256)
  if (
    !/^did:[a-z0-9]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$/.test(
      context.issuer,
    )
  )
    rejectProof()
  boundedAscii(context.lxm, 256)
  if (
    !/^(?:[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.){2,}[a-zA-Z][a-zA-Z0-9]{0,62}$/.test(
      context.lxm,
    )
  )
    rejectProof()
}

function validateKid(kid: unknown, issuer: string): asserts kid is string {
  boundedAscii(kid, 512)
  if (
    !kid.startsWith(`${issuer}#`) ||
    !/^(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})+$/.test(
      kid.slice(issuer.length + 1),
    )
  )
    rejectProof()
}

export async function createServiceAssertion(
  options: CreateServiceAssertionOptions,
): Promise<string> {
  validateIdentity(options)
  validateKid(options.kid, options.issuer)
  const proof = await verifyRequestProof(options.proof, options.request)
  const alg = options.signingKey.jwtAlg
  if (
    (alg !== 'ES256' || options.signingKey.type !== 'p256') &&
    (alg !== 'ES256K' || options.signingKey.type !== 'secp256k1')
  )
    rejectProof()
  const header = { typ: TYP, alg, kid: options.kid }
  const payload = {
    iss: options.issuer,
    aud: proof.claims.aud,
    iat: proof.claims.iat,
    exp: proof.claims.exp,
    lxm: options.lxm,
    proof_hash: await proofDigest(proofUtf8(options.proof)),
  }
  const input = `${encodeProofBytes(proofUtf8(JSON.stringify(header)))}.${encodeProofBytes(proofUtf8(JSON.stringify(payload)))}`
  const signature = await options.signingKey.sign(proofUtf8(input))
  if (
    signature.length !== 64 ||
    !(await options.signingKey.verify(signature, proofUtf8(input), {
      allowMalleableSig: true,
    }))
  )
    rejectProof()
  return `${input}.${encodeProofBytes(signature)}`
}

function validateResolvedKey(
  key: Pick<PublicKey, 'type' | 'jwtAlg'>,
  alg: unknown,
): void {
  if (
    key.jwtAlg !== alg ||
    (alg === 'ES256' ? key.type !== 'p256' : key.type !== 'secp256k1')
  )
    rejectProof()
}

export async function verifyServiceAssertion(
  assertion: string,
  context: ServiceAssertionContext,
  resolver: ServiceAssertionKeyResolver,
): Promise<VerifiedServiceAssertion> {
  validateIdentity(context)
  boundedAscii(assertion, 4096)
  const parts = assertion.split('.')
  if (parts.length !== 3) rejectProof()
  const header = decodeProofObject(parts[0], 1024, ['typ', 'alg', 'kid'])
  if (header.typ !== TYP || (header.alg !== 'ES256' && header.alg !== 'ES256K'))
    rejectProof()
  validateKid(header.kid, context.issuer)
  const payload = decodeProofObject(parts[1], 2048, [
    'iss',
    'aud',
    'iat',
    'exp',
    'lxm',
    'proof_hash',
  ])
  const proof = await verifyRequestProof(context.proof, context.request)
  if (
    payload.iss !== context.issuer ||
    payload.aud !== proof.claims.aud ||
    payload.iat !== proof.claims.iat ||
    payload.exp !== proof.claims.exp ||
    payload.lxm !== context.lxm ||
    payload.proof_hash !== (await proofDigest(proofUtf8(context.proof)))
  )
    rejectProof()
  const signature = decodeProofBytes(parts[2], 64)
  if (signature.length !== 64) rejectProof()
  const key = await resolver.resolve(context.issuer, header.kid)
  validateResolvedKey(key, header.alg)
  if (
    !(await key.verify(signature, proofUtf8(`${parts[0]}.${parts[1]}`), {
      allowMalleableSig: true,
    }))
  )
    rejectProof()
  return Object.freeze({ issuer: context.issuer, kid: header.kid, proof })
}
