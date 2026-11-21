import { parseDidKey, verifySignature } from '@atproto/crypto'
import { StratosError } from '@northskysocial/stratos-core'
import {
  type InnerList,
  isByteSequence,
  isInnerList,
  parseDictionary,
  serializeInnerList,
  serializeList,
} from 'structured-headers'

export interface SpaceSignatureRequest {
  rawHeaders: readonly string[]
}

export interface SpacePresentationBinding {
  keyId: string
  expectedAudience: string
}

export class SpaceHttpSignatureError extends StratosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'InvalidSpaceHttpSignature', options)
    this.name = 'SpaceHttpSignatureError'
  }
}

const EXCHANGE_LABEL = 'atproto-space'
export const SPACE_CREDENTIAL_SIGNATURE_TAG = 'atproto-space-credential'
const EXCHANGE_COMPONENTS = ['authorization']
const PRESENTATION_COMPONENTS = ['authorization', 'atproto-space-audience']
const PRESENTATION_AUTHORIZATION = /^Atproto-Space-Credential \S+$/i
const EXCHANGE_AUTHORIZATION = /^Bearer \S+$/i

/**
 * Verifies the custom mint exchange: one `atproto-space` signature over the
 * bearer delegation, naming its own key. Returns that key.
 */
export async function verifySpaceExchangeSignature(
  request: SpaceSignatureRequest,
): Promise<string> {
  return guardSignature(async () => {
    const headers = readSignatureHeaders(request.rawHeaders)
    const { inputs, signatures } = parseSignatureFields(headers)
    const input = inputs.get(EXCHANGE_LABEL)
    const signature = signatures.get(EXCHANGE_LABEL)
    if (
      !input ||
      !isInnerList(input) ||
      input[1].get('tag') === SPACE_CREDENTIAL_SIGNATURE_TAG ||
      !signature ||
      isInnerList(signature) ||
      !isByteSequence(signature[0]) ||
      signature[1].size !== 0
    ) {
      throw new SpaceHttpSignatureError('Malformed atproto-space signature')
    }
    requireCoveredComponents(input, EXCHANGE_COMPONENTS)
    requireAlgorithm(input)
    const keyId = input[1].get('keyid')
    requireP256DidKey(keyId)
    if (!EXCHANGE_AUTHORIZATION.test(requireHeader(headers, 'authorization'))) {
      throw new SpaceHttpSignatureError('Incorrect authorization scheme')
    }
    await verifyOverBase(
      headers,
      EXCHANGE_COMPONENTS,
      input,
      signature[0].toBase64(),
      keyId,
    )
    return keyId
  })
}

/**
 * Verifies the standard presentation of a space credential: the one signature
 * whose `tag` is `atproto-space-credential`, under whatever label it carries,
 * over the credential and the space audience. The key is the one the
 * credential is bound to; the signature may restate it but never replace it.
 */
export async function verifySpacePresentationSignature(
  request: SpaceSignatureRequest,
  binding: SpacePresentationBinding,
): Promise<string> {
  return guardSignature(async () => {
    const headers = readSignatureHeaders(request.rawHeaders)
    const { inputs, signatures } = parseSignatureFields(headers)
    const tagged = [...inputs].filter(
      ([, member]) =>
        isInnerList(member) &&
        member[1].get('tag') === SPACE_CREDENTIAL_SIGNATURE_TAG,
    )
    if (tagged.length > 1) {
      throw new SpaceHttpSignatureError(
        'More than one credential-tagged signature',
      )
    }
    const [label, input] = tagged[0] ?? []
    const signature = label === undefined ? undefined : signatures.get(label)
    if (
      !input ||
      !isInnerList(input) ||
      !signature ||
      isInnerList(signature) ||
      !isByteSequence(signature[0]) ||
      signature[1].size !== 0
    ) {
      throw new SpaceHttpSignatureError(
        'Missing or malformed credential-tagged signature',
      )
    }
    requireCoveredComponents(input, PRESENTATION_COMPONENTS)
    requireAlgorithm(input)
    requireP256DidKey(binding.keyId)
    if (input[1].has('keyid') && input[1].get('keyid') !== binding.keyId) {
      throw new SpaceHttpSignatureError(
        'Signature keyid does not match credential',
      )
    }
    if (
      !PRESENTATION_AUTHORIZATION.test(requireHeader(headers, 'authorization'))
    ) {
      throw new SpaceHttpSignatureError('Incorrect authorization scheme')
    }
    const audience = requireHeader(headers, 'atproto-space-audience')
    if (!binding.expectedAudience || audience !== binding.expectedAudience) {
      throw new SpaceHttpSignatureError('Incorrect space audience')
    }
    await verifyOverBase(
      headers,
      PRESENTATION_COMPONENTS,
      input,
      signature[0].toBase64(),
      binding.keyId,
    )
    return binding.keyId
  })
}

async function guardSignature(verify: () => Promise<string>): Promise<string> {
  try {
    return await verify()
  } catch (cause) {
    if (cause instanceof SpaceHttpSignatureError) throw cause
    throw new SpaceHttpSignatureError('Invalid HTTP message signature', {
      cause,
    })
  }
}

function parseSignatureFields(headers: Map<string, string>) {
  return {
    inputs: parseDictionary(requireHeader(headers, 'signature-input')),
    signatures: parseDictionary(requireHeader(headers, 'signature')),
  }
}

async function verifyOverBase(
  headers: Map<string, string>,
  components: string[],
  input: InnerList,
  signatureBase64: string,
  keyId: string,
): Promise<void> {
  const lines = components.map(
    (name) => `"${name}": ${requireHeader(headers, name)}`,
  )
  lines.push(`"@signature-params": ${serializeInnerList(input)}`)
  const bytes = Buffer.from(signatureBase64, 'base64')
  if (
    bytes.length !== 64 ||
    !(await verifySignature(
      keyId,
      new TextEncoder().encode(lines.join('\n')),
      bytes,
      { allowMalleableSig: true },
    ))
  ) {
    throw new SpaceHttpSignatureError('Invalid HTTP message signature')
  }
}

function readSignatureHeaders(
  rawHeaders: readonly string[],
): Map<string, string> {
  if (rawHeaders.length % 2 !== 0) {
    throw new SpaceHttpSignatureError('Malformed raw headers')
  }
  const headers = new Map<string, string>()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase()
    if (
      ![
        'authorization',
        'atproto-space-audience',
        'signature-input',
        'signature',
      ].includes(name)
    ) {
      continue
    }
    if (headers.has(name)) {
      throw new SpaceHttpSignatureError('Duplicate signature request header')
    }
    headers.set(name, rawHeaders[index + 1].trim())
  }
  return headers
}

function requireHeader(headers: Map<string, string>, name: string): string {
  const value = headers.get(name)
  if (!value) throw new SpaceHttpSignatureError(`Missing ${name} header`)
  return value
}

function requireCoveredComponents(
  input: InnerList,
  components: string[],
): void {
  if (
    serializeList(input[0]) !== components.map((name) => `"${name}"`).join(', ')
  ) {
    throw new SpaceHttpSignatureError('Incorrect covered components')
  }
}

function requireAlgorithm(input: InnerList): void {
  const params = input[1]
  if (params.has('alg') && params.get('alg') !== 'ecdsa-p256-sha256') {
    throw new SpaceHttpSignatureError('Incorrect signature algorithm')
  }
}

function requireP256DidKey(keyId: unknown): asserts keyId is string {
  if (typeof keyId !== 'string' || parseDidKey(keyId).jwtAlg !== 'ES256') {
    throw new SpaceHttpSignatureError('Signature requires a P-256 did:key')
  }
}
