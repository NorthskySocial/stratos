import { type DidDocument, IdResolver } from '@atproto/identity'
import type { Logger, ServiceEnrollment } from '@northskysocial/stratos-core'
import type { StratosServiceConfig } from './config.js'

/**
 * Create an ID resolver with PLC fallback logic
 * @param cfg - The Stratos service configuration.
 * @param fetchWithUserAgent - The fetch function with user agent set.
 * @param logger - Optional logger for debug and info messages.
 * @returns An ID resolver instance.
 */
export function createIdResolver(
  cfg: StratosServiceConfig,
  fetchWithUserAgent: typeof fetch,
  logger?: Logger,
): IdResolver {
  const idResolver = new IdResolver({
    plcUrl: cfg.identity.plcUrl,
  })

  installServiceKeyShortcut(
    idResolver,
    cfg.enrollment.serviceEnrollments,
    logger,
  )

  const originalResolve = idResolver.handle.resolve.bind(idResolver.handle)
  idResolver.handle.resolve = async (handle: string) => {
    try {
      const result = await originalResolve(handle)
      if (result) return result
    } catch (err) {
      logger?.debug(
        { handle, err: err instanceof Error ? err.message : String(err) },
        'standard handle resolution failed, trying PLC fallback',
      )
    }

    // Fallback: resolve via PLC directory (trusted endpoint, no SSRF risk)
    try {
      const plcUrl = cfg.identity.plcUrl
      const resolveUrl = `${plcUrl}/did-by-handle/${encodeURIComponent(handle)}`
      const resp = await fetchWithUserAgent(resolveUrl)
      if (resp.ok) {
        const did = await resp.text()
        if (did && did.startsWith('did:')) {
          logger?.info(
            { handle, did },
            'resolved handle via PLC directory fallback',
          )
          return did
        }
      }
    } catch (err) {
      logger?.debug(
        { handle, err: err instanceof Error ? err.message : String(err) },
        'PLC handle resolution fallback failed',
      )
    }

    return undefined
  }

  return idResolver
}

/**
 * Short-circuit DID resolution for configured service enrollments that declare
 * a `signingKey`. Their inter-service JWTs are verified against the configured
 * `did:key` without a network lookup, which lets non-resolvable `did:web` DIDs
 * (tests, local development) participate in service auth.
 *
 * @param idResolver - The resolver whose `did.resolve` is wrapped in place.
 * @param serviceEnrollments - Configured service enrollments.
 * @param logger - Optional logger for debug messages.
 */
function installServiceKeyShortcut(
  idResolver: IdResolver,
  serviceEnrollments: ServiceEnrollment[],
  logger?: Logger,
): void {
  const docs = new Map<string, DidDocument>()
  for (const enrollment of serviceEnrollments) {
    if (enrollment.signingKey) {
      docs.set(enrollment.did, buildServiceDidDocument(enrollment))
    }
  }

  if (docs.size === 0) return

  const originalResolve = idResolver.did.resolve.bind(idResolver.did)
  idResolver.did.resolve = async (did: string, forceRefresh?: boolean) => {
    const local = docs.get(did)
    if (local) {
      logger?.debug({ did }, 'resolved service DID via configured signing key')
      return local
    }
    return originalResolve(did, forceRefresh)
  }
}

/**
 * Build a minimal DID document exposing a service enrollment's `did:key`
 * signing key as a `Multikey` verification method.
 */
function buildServiceDidDocument(enrollment: ServiceEnrollment): DidDocument {
  const publicKeyMultibase = enrollment.signingKey!.slice('did:key:'.length)
  return {
    id: enrollment.did,
    verificationMethod: [
      {
        id: `${enrollment.did}#atproto`,
        type: 'Multikey',
        controller: enrollment.did,
        publicKeyMultibase,
      },
    ],
  }
}
