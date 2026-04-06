import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { encode as cborEncode } from '@atcute/cbor'
import { verifySignature } from '@atproto/crypto'

export const STRATOS_URL = import.meta.env.VITE_STRATOS_URL

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

function decodeBytes(val: unknown): Uint8Array | null {
  if (val instanceof Uint8Array || (val && (val as any)._isBuffer))
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

function parseAttestation(val: unknown): ServiceAttestation | null {
  if (typeof val !== 'object' || val === null) return null
  const obj = val as Record<string, unknown>
  if (typeof obj.signingKey !== 'string') return null
  const sig = decodeBytes(obj.sig)
  if (!sig) return null
  return { sig, signingKey: obj.signingKey }
}

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

export async function discoverStratosEnrollment(
  session: OAuthSession,
): Promise<StratosEnrollment | null> {
  const agent = new Agent(session)
  try {
    const res = await agent.com.atproto.repo.listRecords({
      repo: session.sub,
      collection: 'zone.stratos.actor.enrollment',
      limit: 100,
    })
    for (const record of res.data.records) {
      const val = record.value as Record<string, unknown>
      const rkey = record.uri.split('/').pop() ?? ''
      const enrollment = parseEnrollmentRecord(val, rkey)
      if (enrollment) return enrollment
    }
    return null
  } catch {
    return null
  }
}

export async function discoverAllStratosEnrollments(
  session: OAuthSession,
): Promise<StratosEnrollment[]> {
  const agent = new Agent(session)
  try {
    const res = await agent.com.atproto.repo.listRecords({
      repo: session.sub,
      collection: 'zone.stratos.actor.enrollment',
      limit: 100,
    })
    return res.data.records
      .map((record) => {
        const val = record.value as Record<string, unknown>
        const rkey = record.uri.split('/').pop() ?? ''
        return parseEnrollmentRecord(val, rkey)
      })
      .filter((e): e is StratosEnrollment => e !== null)
  } catch {
    return []
  }
}

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

export function enrollInStratos(stratosUrl: string, handle: string): void {
  const url = new URL('/oauth/authorize', stratosUrl)
  url.searchParams.set('handle', handle)
  url.searchParams.set('redirect_uri', window.location.origin + '/')
  window.location.href = url.toString()
}
