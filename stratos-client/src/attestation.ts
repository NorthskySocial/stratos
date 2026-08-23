import { encode as cborEncode, fromBytes, isBytes } from '@atcute/cbor'
import { verifySigWithDidKey } from '@atcute/crypto'

/**
 * result of an enrollment attestation check.
 *
 * the check never throws. when it cannot complete, valid is false and error
 * holds the reason.
 */
export interface AttestationResult {
  valid: boolean
  serviceKey: string
  userSigningKey: string
  boundaries: Array<string>
  error?: string
}

interface EnrollmentWithAttestation {
  signingKey: string
  attestation: { sig: unknown; signingKey: string }
  boundaries?: unknown
}

// @atcute/crypto requires ArrayBuffer-backed arrays, but @atcute/cbor returns
// ArrayBufferLike. copy the bytes to satisfy the narrower type. an attestation
// signature and its payload are both small, so the copy costs little.
const toArrayBufferBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes)

const isEnrollmentWithAttestation = (
  val: unknown,
): val is EnrollmentWithAttestation => {
  if (typeof val !== 'object' || val === null) return false
  const obj = val as Record<string, unknown>
  if (typeof obj.signingKey !== 'string') return false
  if (typeof obj.attestation !== 'object' || obj.attestation === null) {
    return false
  }
  const att = obj.attestation as Record<string, unknown>
  return (
    typeof att.signingKey === 'string' &&
    (isBytes(att.sig) || att.sig instanceof Uint8Array)
  )
}

/**
 * verifies the service attestation in an enrollment record.
 *
 * the attestation is an ECDSA signature by the service did:key. the service
 * signs the DAG-CBOR encoding of {boundaries, did, signingKey}, where the
 * keys are in sorted order and the boundaries are sorted strings.
 *
 * @param recordValue the raw enrollment record value (JSON or decoded CBOR)
 * @param userDid the DID of the enrolled user (repo owner)
 * @returns the attestation verification result; never throws
 */
export const verifyEnrollmentAttestation = async (
  recordValue: unknown,
  userDid: string,
): Promise<AttestationResult> => {
  if (!isEnrollmentWithAttestation(recordValue)) {
    return {
      valid: false,
      serviceKey: '',
      userSigningKey: '',
      boundaries: [],
      error: 'Record missing attestation or signingKey fields',
    }
  }

  const {
    signingKey: userSigningKey,
    attestation,
    boundaries: rawBoundaries,
  } = recordValue

  const serviceKey = attestation.signingKey
  const boundaries = Array.isArray(rawBoundaries)
    ? rawBoundaries.map((b: { value: string }) => b.value).sort()
    : []

  try {
    const sigBytes =
      attestation.sig instanceof Uint8Array
        ? attestation.sig
        : fromBytes(attestation.sig as Parameters<typeof fromBytes>[0])

    const payload = cborEncode({
      boundaries,
      did: userDid,
      signingKey: userSigningKey,
    })

    const valid = await verifySigWithDidKey(
      serviceKey,
      toArrayBufferBytes(sigBytes),
      toArrayBufferBytes(payload),
    )
    return { valid, serviceKey, userSigningKey, boundaries }
  } catch (err) {
    return {
      valid: false,
      serviceKey,
      userSigningKey,
      boundaries,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
