import type { GenerateStubInput, StubRecord, RecordSource } from './types.js'

/**
 * Generate a stub record from a full record
 * The stub is written to the user's PDS and contains a source field
 * pointing to the hydration service where full content can be retrieved.
 */
export function generateStub(input: GenerateStubInput): StubRecord {
  const source: RecordSource = {
    vary: 'authenticated',
    subject: {
      uri: input.uri,
      cid: input.cid.toString(),
    },
    service: input.serviceDid,
  }

  return {
    $type: input.recordType,
    source,
    createdAt: input.createdAt,
  }
}

/**
 * Check if a record is a stub (has source field)
 */
export function isStubRecord(record: unknown): record is StubRecord {
  if (typeof record !== 'object' || record === null) {
    return false
  }
  const r = record as Record<string, unknown>
  return (
    typeof r.source === 'object' &&
    r.source !== null &&
    typeof (r.source as Record<string, unknown>).vary === 'string' &&
    typeof (r.source as Record<string, unknown>).subject === 'object' &&
    typeof (r.source as Record<string, unknown>).service === 'string'
  )
}

/**
 * Extract source field from a stub record
 */
export function extractSource(record: unknown): RecordSource | null {
  if (!isStubRecord(record)) {
    return null
  }
  return record.source
}

/**
 * Parse the service DID and fragment from a source.service field
 * @example "did:plc:abc123#atproto_pns" -> { did: "did:plc:abc123", fragment: "atproto_pns" }
 */
export function parseServiceDid(serviceDid: string): {
  did: string
  fragment: string | null
} {
  const hashIndex = serviceDid.indexOf('#')
  if (hashIndex === -1) {
    return { did: serviceDid, fragment: null }
  }
  return {
    did: serviceDid.slice(0, hashIndex),
    fragment: serviceDid.slice(hashIndex + 1),
  }
}
