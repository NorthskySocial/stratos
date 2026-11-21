import {
  resolveRepositoryTarget,
  type BoundaryWriteClient,
  type RepositoryTarget,
} from '@northskysocial/stratos-client'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { createServiceFetch } from './stratos-agent'
import type { StratosEnrollment } from './stratos'

// The same hosts stratos-browser's service fetch accepts over plain http.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The routing helpers accept only https origins, which a local stack at http://127.0.0.1 is not. */
function loopbackHttpOrigin(service: string): string | null {
  try {
    const url = new URL(service)
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
      return null
    }
    if (url.username || url.password || url.pathname !== '/') return null
    if (url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function resolveStratosTarget(enrollment: StratosEnrollment): RepositoryTarget {
  const local = loopbackHttpOrigin(enrollment.service)
  if (local && enrollment.custody === 'stratos') {
    return { kind: 'stratos', url: local }
  }
  return resolveRepositoryTarget(enrollment, {
    authorityServiceUrl: enrollment.service,
  })
}

/** The write client for a stratos-custody member: the member's session, sent to their enrolled service. */
export function stratosWriteClient(
  session: Pick<OAuthSession, 'fetchHandler'>,
  enrollment: StratosEnrollment,
): BoundaryWriteClient {
  return {
    handler: createServiceFetch(session as OAuthSession, enrollment.service),
    resolveTarget: () => resolveStratosTarget(enrollment),
  }
}
