import { encode as cborEncode } from '@atcute/cbor'

/**
 * Creates an attestation payload for the given DID, boundaries, and user signing key.
 * @param did - The DID to attest.
 * @param boundaries - The boundaries to attest.
 * @param userSigningKey - The user's signing key.
 * @returns The CBOR-encoded attestation payload.
 */
export function createAttestationPayload(
  did: string,
  boundaries: string[],
  userSigningKey: string,
): Uint8Array {
  const sorted = [...boundaries].sort()
  return cborEncode({ boundaries: sorted, did, signingKey: userSigningKey })
}
