/**
 * Shared compact-JWT structural decoding for the space auth verifiers
 * (delegation, space-credential, client-attestation). Each verifier keeps its
 * own distinct error type by supplying an `onError` factory, so a hardening
 * change to the parse path (e.g. the non-object payload guard) lands in exactly
 * one place instead of being copy-pasted per token class.
 */

/**
 * Split and base64url-decode a compact JWT (`header.payload.sig`) into its
 * header and payload objects. Validates only structural well-formedness: three
 * segments, valid base64url JSON, and both header and payload being non-null
 * objects. Claim/header-value validation is the caller's responsibility.
 *
 * @param token - The compact JWT string.
 * @param onError - Produces the caller's distinct malformed-token error.
 * @returns The three raw segments plus the decoded header and payload.
 * @throws Whatever `onError` returns, for any structural failure.
 */
export function decodeCompactJwt<H, P>(
  token: string,
  onError: (message: string) => Error,
): { parts: string[]; header: H; payload: P } {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw onError('Invalid JWT format')
  }
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString(),
    ) as H
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString(),
    ) as P
    if (!header || typeof header !== 'object') {
      throw new Error('missing header')
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('missing payload')
    }
    return { parts, header, payload }
  } catch {
    throw onError('Invalid JWT encoding')
  }
}
