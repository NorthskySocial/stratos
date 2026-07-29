import { encode as cborEncode, fromBytes, isBytes } from '@atcute/cbor'
import { verifySigWithDidKey } from '@atcute/crypto'

/**
 * result of verifying a service attestation on an enrollment record.
 */
export interface AttestationResult {
  valid: boolean
  serviceKey: string
  userSigningKey: string
  boundaries: string[]
  error?: string
}

interface EnrollmentRecordValue {
  signingKey: string
  attestation: {
    sig: { $bytes: string } | Uint8Array
    signingKey: string
  }
  boundaries?: Array<{ value: string }>
}

const isEnrollmentWithAttestation = (
  val: unknown,
): val is EnrollmentRecordValue => {
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
 * verifies the service attestation embedded in an enrollment record.
 * the attestation is an ECDSA signature by the service's did:key over the
 * DAG-CBOR encoding of {boundaries, did, signingKey} with sorted keys.
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
    ? rawBoundaries.map((b) => b.value).sort()
    : []

  try {
    const sigBytes =
      attestation.sig instanceof Uint8Array
        ? attestation.sig
        : fromBytes(attestation.sig)

    const payload = cborEncode({
      boundaries,
      did: userDid,
      signingKey: userSigningKey,
    })

    const valid = await verifySigWithDidKey(
      serviceKey,
      sigBytes as Uint8Array<ArrayBuffer>,
      payload,
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
