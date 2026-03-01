import { encode as cborEncode } from '@atcute/cbor'

export function createAttestationPayload(
  did: string,
  boundaries: string[],
  userSigningKey: string,
): Uint8Array {
  const sorted = [...boundaries].sort()
  return cborEncode({ boundaries: sorted, did, signingKey: userSigningKey })
}
