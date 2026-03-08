import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

export const STRATOS_URL = import.meta.env.VITE_STRATOS_URL as string | undefined

export interface StratosEnrollment {
  service: string
  boundaries: Array<{ value: string }>
  signingKey: string
  createdAt: string
}

export async function discoverStratosEnrollment(
  session: OAuthSession,
): Promise<StratosEnrollment | null> {
  const agent = new Agent(session)
  try {
    const res = await agent.com.atproto.repo.getRecord({
      repo: session.sub,
      collection: 'zone.stratos.actor.enrollment',
      rkey: 'self',
    })
    const val = res.data.value as Record<string, unknown>
    if (typeof val.service !== 'string') return null
    return {
      service: val.service,
      boundaries: Array.isArray(val.boundaries) ? val.boundaries : [],
      signingKey: (val.signingKey as string) ?? '',
      createdAt: (val.createdAt as string) ?? '',
    }
  } catch {
    return null
  }
}

export function enrollInStratos(stratosUrl: string, handle: string): void {
  const url = new URL('/oauth/authorize', stratosUrl)
  url.searchParams.set('handle', handle)
  url.searchParams.set('redirect_uri', window.location.origin + '/')
  window.location.href = url.toString()
}
