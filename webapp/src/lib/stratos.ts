import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { encode as cborEncode } from '@atcute/cbor'
import { verifySignature } from '@atproto/crypto'
import { configureAgent } from './stratos-agent'

export let STRATOS_URL = import.meta.env.VITE_STRATOS_URL
export let STRATOS_SERVICE_DID = import.meta.env.VITE_STRATOS_SERVICE_DID

/**
 * Sets the DID of the Stratos service.
 * @param did - The DID of the Stratos service.
 */
export function setStratosServiceDid(did: string | undefined) {
  STRATOS_SERVICE_DID = did
}

/**
 * Sets the URL of the Stratos service.
 * @param url - The URL of the Stratos service.
 */
export function setStratosUrl(url: string | undefined) {
  STRATOS_URL = url
}

export const APPVIEW_URL = import.meta.env.VITE_APPVIEW_URL

export interface ServiceAttestation {
  sig: Uint8Array
  signingKey: string
}

export interface StratosEnrollment {
  service: string
  boundaries: Array<{ value: string }>
  signingKey: string
  attestation: ServiceAttestation | null
  createdAt: string
  rkey: string
}

export interface StratosServiceStatus {
  enrolled: boolean
  enrolledAt?: string
  active?: boolean
}

/**
 * Converts a byte array to a Uint8Array.
 * @param val - The byte array value.
 * @returns The Uint8Array, or null if conversion fails.
 */
function decodeBytes(val: unknown): Uint8Array | null {
  if (
    val instanceof Uint8Array ||
    (val && typeof val === 'object' && '_isBuffer' in val && val._isBuffer)
  )
    return val as Uint8Array
  if (typeof val === 'object' && val !== null && '$bytes' in val) {
    const b64 = (val as { $bytes: string }).$bytes
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  return null
}

/**
 * Parses a service attestation value.
 * @param val - The attestation value.
 * @returns The parsed attestation, or null if parsing fails.
 */
function parseAttestation(val: unknown): ServiceAttestation | null {
  if (typeof val !== 'object' || val === null) return null
  const obj = val as Record<string, unknown>
  if (typeof obj.signingKey !== 'string') return null
  const sig = decodeBytes(obj.sig)
  if (!sig) return null
  return { sig, signingKey: obj.signingKey }
}

/**
 * Parses a Stratos enrollment record.
 * @param val - The record value.
 * @param rkey - The record key.
 * @returns The parsed enrollment record, or null if parsing fails.
 */
function parseEnrollmentRecord(
  val: Record<string, unknown>,
  rkey: string,
): StratosEnrollment | null {
  if (typeof val.service !== 'string') return null
  return {
    service: val.service,
    boundaries: Array.isArray(val.boundaries) ? val.boundaries : [],
    signingKey: (val.signingKey as string) ?? '',
    attestation: parseAttestation(val.attestation),
    createdAt: (val.createdAt as string) ?? '',
    rkey,
  }
}

/**
 * Converts a service DID to a rkey.
 * @param serviceDid - The service DID.
 * @returns The rkey.
 */
export function serviceDIDToRkey(serviceDid: string): string {
  return serviceDid.replace(/%3A/gi, ':')
}

/**
 * Discovers the Stratos enrollment record for the user.
 * @param session - The OAuth session.
 * @returns The Stratos enrollment record, or null if not found.
 */
export async function discoverStratosEnrollment(
  session: OAuthSession,
): Promise<StratosEnrollment | null> {
  const agent = configureAgent(new Agent(session))
  if (STRATOS_SERVICE_DID) {
    const rkey = serviceDIDToRkey(STRATOS_SERVICE_DID)
    try {
      const res = await agent.com.atproto.repo.getRecord({
        repo: session.sub,
        collection: 'zone.stratos.actor.enrollment',
        rkey,
      })
      if (res.data.value) {
        return parseEnrollmentRecord(
          res.data.value as Record<string, unknown>,
          rkey,
        )
      }
    } catch (err) {
      console.warn(`Failed to get enrollment record by rkey ${rkey}:`, err)
    }
  }

  // Fallback to listing records
  try {
    const res = await agent.com.atproto.repo.listRecords({
      repo: session.sub,
      collection: 'zone.stratos.actor.enrollment',
      limit: 10,
    })
    if (res.data.records && res.data.records.length > 0) {
      // If we have a preferred DID, try to find it in the list first
      if (STRATOS_SERVICE_DID) {
        const preferred = res.data.records.find((r) =>
          r.uri.endsWith(`/${serviceDIDToRkey(STRATOS_SERVICE_DID!)}`),
        )
        if (preferred) {
          return parseEnrollmentRecord(
            preferred.value as Record<string, unknown>,
            preferred.uri.split('/').pop()!,
          )
        }
      }
      // Otherwise return the first one
      const first = res.data.records[0]
      return parseEnrollmentRecord(
        first.value as Record<string, unknown>,
        first.uri.split('/').pop()!,
      )
    }
  } catch (err) {
    console.warn('Failed to list enrollment records:', err)
  }

  return null
}

/**
 * Discovers all Stratos enrollment records for the user.
 * @param session - The OAuth session.
 * @returns The array of Stratos enrollment records, or an empty array if none found.
 */
export async function discoverAllStratosEnrollments(
  session: OAuthSession,
): Promise<StratosEnrollment[]> {
  const agent = configureAgent(new Agent(session))
  try {
    const res = await agent.com.atproto.repo.listRecords({
      repo: session.sub,
      collection: 'zone.stratos.actor.enrollment',
      limit: 50,
    })
    return (res.data.records || [])
      .map((r) =>
        parseEnrollmentRecord(
          r.value as Record<string, unknown>,
          r.uri.split('/').pop()!,
        ),
      )
      .filter((e): e is StratosEnrollment => e !== null)
  } catch (err) {
    console.warn('Failed to discover all enrollments:', err)
    return []
  }
}

/**
 * Checks the status of the Stratos service at the given URL for the given DID.
 * @param serviceUrl - The URL of the Stratos service.
 * @param did - The DID of the user.
 * @returns The status of the Stratos service, or { enrolled: false } if an error occurs.
 */
export async function checkStratosServiceStatus(
  serviceUrl: string,
  did: string,
): Promise<StratosServiceStatus> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const url = new URL('/xrpc/zone.stratos.enrollment.status', serviceUrl)
    url.searchParams.set('did', did)
    const res = await fetch(url.href, { signal: controller.signal })
    clearTimeout(timeoutId)
    if (!res.ok) return { enrolled: false }
    return await res.json()
  } catch (err) {
    clearTimeout(timeoutId)
    console.warn(`Failed to check Stratos status at ${serviceUrl}:`, err)
    return { enrolled: false }
  }
}

/**
 * Verifies the attestation for a user's Stratos enrollment.'
 * @param did - The DID of the user.
 * @param enrollment - The Stratos enrollment record.
 * @returns True if the attestation is valid, false otherwise.
 */
export async function verifyAttestation(
  did: string,
  enrollment: StratosEnrollment,
): Promise<boolean> {
  if (!enrollment.attestation) return false
  try {
    const boundaries = enrollment.boundaries.map((b) => b.value).sort()
    const payload = cborEncode({
      boundaries,
      did,
      signingKey: enrollment.signingKey,
    })
    return await verifySignature(
      enrollment.attestation.signingKey,
      payload,
      enrollment.attestation.sig,
    )
  } catch {
    return false
  }
}

/**
 * Fetches the list of domains from the Stratos service.
 * @param serviceUrl - The URL of the Stratos service.
 * @returns The list of domains, or an empty array if an error occurs.
 */
export async function fetchServerDomains(
  serviceUrl: string,
): Promise<string[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const url = new URL('/xrpc/zone.stratos.server.listDomains', serviceUrl)
    const res = await fetch(url.href, { signal: controller.signal })
    clearTimeout(timeoutId)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.domains) ? data.domains : []
  } catch (err) {
    clearTimeout(timeoutId)
    console.warn(`Failed to fetch domains from ${serviceUrl}:`, err)
    return []
  }
}

/**
 * Enrolls the user in the Stratos service.
 * @param stratosUrl - The URL of the Stratos service.
 * @param handle - The handle of the user.
 */
export function enrollInStratos(stratosUrl: string, handle: string): void {
  const url = new URL('/oauth/authorize', stratosUrl)
  url.searchParams.set('handle', handle)
  url.searchParams.set('redirect_uri', window.location.origin + '/')
  window.location.href = url.toString()
}
