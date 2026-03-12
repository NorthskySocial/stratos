import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

export const STRATOS_URL = import.meta.env.VITE_STRATOS_URL as
  | string
  | undefined

export interface StratosEnrollment {
  service: string
  boundaries: Array<{ value: string }>
  signingKey: string
  createdAt: string
  rkey: string
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
      if (typeof val.service !== 'string') continue
      const rkey = record.uri.split('/').pop() ?? ''
      return {
        service: val.service,
        boundaries: Array.isArray(val.boundaries) ? val.boundaries : [],
        signingKey: (val.signingKey as string) ?? '',
        createdAt: (val.createdAt as string) ?? '',
        rkey,
      }
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
        if (typeof val.service !== 'string') return null
        const rkey = record.uri.split('/').pop() ?? ''
        return {
          service: val.service,
          boundaries: Array.isArray(val.boundaries) ? val.boundaries : [],
          signingKey: (val.signingKey as string) ?? '',
          createdAt: (val.createdAt as string) ?? '',
          rkey,
        }
      })
      .filter((e): e is StratosEnrollment => e !== null)
  } catch {
    return []
  }
}

export function enrollInStratos(stratosUrl: string, handle: string): void {
  const url = new URL('/oauth/authorize', stratosUrl)
  url.searchParams.set('handle', handle)
  url.searchParams.set('redirect_uri', window.location.origin + '/')
  window.location.href = url.toString()
}
