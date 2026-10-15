import { fromBase64Url, toBase64Url } from '@atcute/multibase'

export const encodeProofBytes = toBase64Url
export const proofUtf8 = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value)

export function rejectProof(): never {
  throw new Error('Invalid Stratos request proof')
}

export function decodeProofBytes(value: string, maxBytes: number): Uint8Array {
  if (
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    rejectProof()
  const bytes = fromBase64Url(value)
  if (bytes.length > maxBytes || toBase64Url(bytes) !== value) rejectProof()
  return bytes
}

export function decodeProofObject(
  segment: string,
  maxBytes: number,
  fields: readonly string[],
): Record<string, unknown> {
  const bytes = decodeProofBytes(segment, maxBytes)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) rejectProof()
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    rejectProof()
  const pair =
    /\s*("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*([,}])/y
  const opening = /^\s*\{/.exec(text)
  if (!opening) rejectProof()
  pair.lastIndex = opening[0].length
  const seen = new Set<string>()
  for (;;) {
    const match = pair.exec(text)
    if (!match) rejectProof()
    const key = JSON.parse(match[1]) as string
    if (!fields.includes(key) || seen.has(key)) rejectProof()
    seen.add(key)
    if (match[3] === '}') {
      if (!/^\s*$/.test(text.slice(pair.lastIndex))) rejectProof()
      break
    }
  }
  if (seen.size !== fields.length) rejectProof()
  return parsed as Record<string, unknown>
}

export async function proofDigest(bytes: Uint8Array): Promise<string> {
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  )
}
