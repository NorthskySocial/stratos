import { P256PublicKey, parseDidKey, type PrivateKey } from '@atcute/crypto'
import {
  decodeProofBytes,
  decodeProofObject,
  encodeProofBytes,
  proofDigest,
  proofUtf8,
  rejectProof,
} from './request-proof-codec.js'

const TYP = 'stratos-request-proof-v1+jwt'
const CLAIMS = ['aud', 'htm', 'target', 'ath', 'body_hash', 'iat', 'exp', 'jti']

export interface RequestProofContext {
  credential: string
  credentialKey: string
  authority: string
  method: string
  target: string
  body: Uint8Array
  contentEncoding?: string
  now: number
}

export interface CreateRequestProofOptions extends RequestProofContext {
  signingKey: PrivateKey
  lifetimeSeconds?: number
}

export interface RequestProofClaims {
  readonly aud: string
  readonly htm: string
  readonly target: string
  readonly ath: string
  readonly body_hash: string
  readonly iat: number
  readonly exp: number
  readonly jti: string
}

export interface VerifiedRequestProof {
  readonly claims: RequestProofClaims
  readonly credentialKey: string
  readonly principal: string
  readonly replayId: string
}

export interface RequestProofReplayStore {
  consumeOnce(kind: string, jti: string, ttlSeconds: number): Promise<boolean>
}

export interface RequestProofReplayEntry {
  readonly kind: 'stratos-request-proof-v1'
  readonly jti: string
  readonly ttlSeconds: number
}

function ascii(value: unknown, max: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[^\x21-\x7e]/.test(value)
  )
    rejectProof()
}

function validateTarget(target: string): void {
  ascii(target, 2048)
  if (!target.startsWith('/') || target.startsWith('//')) rejectProof()
  const queryStart = target.indexOf('?')
  const path = queryStart === -1 ? target : target.slice(0, queryStart)
  const query = queryStart === -1 ? '' : target.slice(queryStart + 1)
  if (
    !/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*$/.test(path) ||
    !/^(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*$/.test(query)
  )
    rejectProof()
}

function validateContext(context: RequestProofContext): void {
  ascii(context.authority, 256)
  if (
    !/^did:[a-z0-9]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$/.test(
      context.authority,
    )
  )
    rejectProof()
  if (context.method !== 'GET') rejectProof()
  validateTarget(context.target)
  ascii(context.credential, 16384)
  if (
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(context.credential)
  )
    rejectProof()
  if (
    !(context.body instanceof Uint8Array) ||
    context.body.byteLength !== 0 ||
    (context.contentEncoding !== undefined &&
      context.contentEncoding !== 'identity')
  )
    rejectProof()
  if (!Number.isSafeInteger(context.now) || context.now < 0) rejectProof()
}

async function boundPublicKey(kid: string): Promise<P256PublicKey> {
  ascii(kid, 256)
  const parsed = parseDidKey(kid)
  if (
    parsed.type !== 'p256' ||
    parsed.publicKeyBytes.length !== 33 ||
    (parsed.publicKeyBytes[0] !== 2 && parsed.publicKeyBytes[0] !== 3)
  )
    rejectProof()
  const key = await P256PublicKey.importRaw(parsed.publicKeyBytes)
  if ((await key.exportPublicKey('did')) !== kid) rejectProof()
  return key
}

function validateTime(iat: unknown, exp: unknown, now: number): void {
  if (
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    iat < 0 ||
    exp < 0 ||
    exp <= iat ||
    exp - iat > 60 ||
    iat > now + 5 ||
    now >= exp + 5
  )
    rejectProof()
}

export async function createRequestProof(
  options: CreateRequestProofOptions,
): Promise<string> {
  validateContext(options)
  const publicKey = await boundPublicKey(options.credentialKey)
  if (
    options.signingKey.type !== 'p256' ||
    options.signingKey.jwtAlg !== 'ES256' ||
    (await options.signingKey.exportPublicKey('did')) !== options.credentialKey
  )
    rejectProof()
  const exp = options.now + (options.lifetimeSeconds ?? 60)
  validateTime(options.now, exp, options.now)
  const header = { typ: TYP, alg: 'ES256', kid: options.credentialKey }
  const claims: RequestProofClaims = {
    aud: options.authority,
    htm: options.method,
    target: options.target,
    ath: await proofDigest(proofUtf8(options.credential)),
    body_hash: await proofDigest(options.body),
    iat: options.now,
    exp,
    jti: encodeProofBytes(crypto.getRandomValues(new Uint8Array(16))),
  }
  const input = `${encodeProofBytes(proofUtf8(JSON.stringify(header)))}.${encodeProofBytes(proofUtf8(JSON.stringify(claims)))}`
  const signature = await options.signingKey.sign(proofUtf8(input))
  if (
    !(await publicKey.verify(signature, proofUtf8(input), {
      allowMalleableSig: true,
    }))
  )
    rejectProof()
  return `${input}.${encodeProofBytes(signature)}`
}

function validateDigestClaim(value: unknown, length: number): void {
  if (
    typeof value !== 'string' ||
    decodeProofBytes(value, length).length !== length
  )
    rejectProof()
}

export async function verifyRequestProof(
  proof: string,
  context: RequestProofContext,
): Promise<VerifiedRequestProof> {
  validateContext(context)
  ascii(proof, 8192)
  const parts = proof.split('.')
  if (parts.length !== 3) rejectProof()
  const header = decodeProofObject(parts[0], 512, ['typ', 'alg', 'kid'])
  if (
    header.typ !== TYP ||
    header.alg !== 'ES256' ||
    header.kid !== context.credentialKey
  )
    rejectProof()
  const payload = decodeProofObject(parts[1], 4096, CLAIMS)
  if (
    payload.aud !== context.authority ||
    payload.htm !== context.method ||
    payload.target !== context.target
  )
    rejectProof()
  validateTime(payload.iat, payload.exp, context.now)
  validateDigestClaim(payload.ath, 32)
  validateDigestClaim(payload.body_hash, 32)
  validateDigestClaim(payload.jti, 16)
  if (
    payload.ath !== (await proofDigest(proofUtf8(context.credential))) ||
    payload.body_hash !== (await proofDigest(context.body))
  )
    rejectProof()
  const signature = decodeProofBytes(parts[2], 64)
  const key = await boundPublicKey(context.credentialKey)
  if (
    signature.length !== 64 ||
    !(await key.verify(signature, proofUtf8(`${parts[0]}.${parts[1]}`), {
      allowMalleableSig: true,
    }))
  )
    rejectProof()
  const claims = Object.freeze(payload) as unknown as RequestProofClaims
  const principal = await proofDigest(
    proofUtf8(JSON.stringify([claims.aud, context.credentialKey, claims.ath])),
  )
  const replayId = await proofDigest(
    proofUtf8(JSON.stringify([principal, claims.jti])),
  )
  return Object.freeze({
    claims,
    credentialKey: context.credentialKey,
    principal,
    replayId,
  })
}

export function requestProofReplayEntry(
  verified: VerifiedRequestProof,
  nowSeconds: number,
): RequestProofReplayEntry {
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0) rejectProof()
  validateTime(verified.claims.iat, verified.claims.exp, nowSeconds)
  return Object.freeze({
    kind: 'stratos-request-proof-v1',
    jti: verified.replayId,
    ttlSeconds: Math.max(1, Math.ceil(verified.claims.exp + 5 - nowSeconds)),
  })
}
