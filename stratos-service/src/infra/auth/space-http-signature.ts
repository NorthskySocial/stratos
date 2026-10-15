import { parseDidKey, verifySignature } from '@atproto/crypto'
import { StratosError } from '@northskysocial/stratos-core'
import {
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

export async function verifySpaceExchangeSignature(
  request: SpaceSignatureRequest,
): Promise<string> {
  return verifySpaceSignature(request, ['authorization'])
}

export async function verifySpacePresentationSignature(
  request: SpaceSignatureRequest,
  binding: SpacePresentationBinding,
): Promise<string> {
  return verifySpaceSignature(
    request,
    ['authorization', 'atproto-space-audience'],
    binding,
  )
}

async function verifySpaceSignature(
  request: SpaceSignatureRequest,
  components: string[],
  binding?: SpacePresentationBinding,
): Promise<string> {
  try {
    const headers = readSignatureHeaders(request.rawHeaders)
    const input = parseDictionary(
      requireHeader(headers, 'signature-input'),
    ).get('atproto-space')
    const signature = parseDictionary(requireHeader(headers, 'signature')).get(
      'atproto-space',
    )
    if (
      !input ||
      !isInnerList(input) ||
      !signature ||
      isInnerList(signature) ||
      !isByteSequence(signature[0]) ||
      signature[1].size !== 0
    ) {
      throw new SpaceHttpSignatureError('Malformed atproto-space signature')
    }
    const keyId = validateSignatureProfile(input, components, binding)
    validateAuthorization(headers, binding)
    const lines = components.map(
      (name) => `"${name}": ${requireHeader(headers, name)}`,
    )
    lines.push(`"@signature-params": ${serializeInnerList(input)}`)
    const bytes = Buffer.from(signature[0].toBase64(), 'base64')
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
    return keyId
  } catch (cause) {
    if (cause instanceof SpaceHttpSignatureError) throw cause
    throw new SpaceHttpSignatureError('Invalid HTTP message signature', {
      cause,
    })
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

function validateSignatureProfile(
  input: import('structured-headers').InnerList,
  components: string[],
  binding?: SpacePresentationBinding,
): string {
  const [covered, params] = input
  if (
    serializeList(covered) !== components.map((name) => `"${name}"`).join(', ')
  ) {
    throw new SpaceHttpSignatureError('Incorrect covered components')
  }
  if (params.has('alg') && params.get('alg') !== 'ecdsa-p256-sha256') {
    throw new SpaceHttpSignatureError('Incorrect signature algorithm')
  }
  const keyId = binding?.keyId ?? params.get('keyid')
  if (typeof keyId !== 'string' || parseDidKey(keyId).jwtAlg !== 'ES256') {
    throw new SpaceHttpSignatureError('Signature requires a P-256 did:key')
  }
  if (binding && params.has('keyid') && params.get('keyid') !== keyId) {
    throw new SpaceHttpSignatureError(
      'Signature keyid does not match credential',
    )
  }
  return keyId
}

function validateAuthorization(
  headers: Map<string, string>,
  binding?: SpacePresentationBinding,
): void {
  const authorization = requireHeader(headers, 'authorization')
  const scheme = binding ? /^Atproto-Space \S+$/i : /^Bearer \S+$/i
  if (!scheme.test(authorization)) {
    throw new SpaceHttpSignatureError('Incorrect authorization scheme')
  }
  if (binding) {
    const audience = requireHeader(headers, 'atproto-space-audience')
    if (!binding.expectedAudience || audience !== binding.expectedAudience) {
      throw new SpaceHttpSignatureError('Incorrect space audience')
    }
  }
}
