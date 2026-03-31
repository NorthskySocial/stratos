import { IdResolver } from '@atproto/identity'
import type { StratosServiceConfig } from './config.js'
import type { Logger } from '@northskysocial/stratos-core'

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
