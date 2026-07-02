import {
  ensureQualifiedBoundaries,
  InvalidServiceEnrollmentError,
  spaceUriToBoundary,
} from '@northskysocial/stratos-core'

/**
 * Per-space app-gating policy (SWP-08, task 3).
 *
 * The app-axis is a service-side setting mapping a space (by its Stratos
 * boundary `{serviceDid}/{skey}`, i.e. keyed on the space's skey/domainName) to
 * an {@link AppAccess} policy:
 *   - `#open` (the DEFAULT): no client attestation required. A space with no
 *     configured entry behaves exactly like SWP-06.
 *   - `#allowList`: a client attestation is REQUIRED, and its *attested*
 *     `client_id` (`iss`) must be a member of the allow-list.
 *
 * This mirrors the existing `serviceEnrollments` / `STRATOS_ALLOWED_DOMAINS`
 * config mechanism (see `config.ts`): entries arrive as JSON (inline env +
 * optional file), boundaries are qualified against the service DID, and invalid
 * input fails fast on startup with {@link InvalidServiceEnrollmentError}. No new
 * lexicon is introduced for the config.
 */

/** The `#open` policy (default): no attestation required. */
export interface OpenAppAccess {
  kind: 'open'
}

/** The `#allowList` policy: attestation required; `client_id` must be listed. */
export interface AllowListAppAccess {
  kind: 'allowList'
  /** The client_ids (HTTPS URLs) permitted to obtain credentials. */
  clientIds: string[]
}

/** A per-space app-access policy. */
export type AppAccess = OpenAppAccess | AllowListAppAccess

/** The default policy for any space without an explicit entry. */
export const DEFAULT_APP_ACCESS: OpenAppAccess = { kind: 'open' }

/**
 * A validated app-gating configuration: a map from qualified boundary
 * (`{serviceDid}/{skey}`) → {@link AppAccess}.
 */
export interface SpaceAppAccessConfig {
  byBoundary: Map<string, AppAccess>
}

/** Raw app-access entry as parsed from configuration, before validation. */
export interface RawSpaceAppAccess {
  /** Bare skey/domainName or qualified boundary of the target space. */
  space?: unknown
  /** Policy discriminator: `"open"` or `"allowList"`. */
  access?: unknown
  /** For `allowList`: the permitted client_ids. */
  clientIds?: unknown
}

/**
 * Validate and normalise raw app-access config entries.
 *
 * Each entry's `space` is qualified against `serviceDid` (bare skeys are
 * auto-qualified) and must be unique. `access` must be `"open"` or
 * `"allowList"`; an `allowList` must declare a non-empty `clientIds` array of
 * HTTPS URLs. Invalid input fails fast with {@link InvalidServiceEnrollmentError}
 * (reusing the existing config-error type, matching the enrollment mechanism).
 *
 * @param entries - Raw entries parsed from configuration.
 * @param serviceDid - Service DID used to qualify boundaries.
 * @returns A validated {@link SpaceAppAccessConfig}.
 */
export function validateSpaceAppAccess(
  entries: RawSpaceAppAccess[],
  serviceDid: string,
): SpaceAppAccessConfig {
  const byBoundary = new Map<string, AppAccess>()

  for (const entry of entries) {
    const space = entry.space
    if (typeof space !== 'string' || space.length === 0) {
      throw new InvalidServiceEnrollmentError(
        'space app-access entry is missing a non-empty "space"',
      )
    }

    let boundary: string
    try {
      boundary = ensureQualifiedBoundaries(serviceDid, [space])[0]
    } catch (err) {
      throw new InvalidServiceEnrollmentError(
        `space app-access entry "${space}" is not a boundary for this service`,
        { cause: err },
      )
    }

    if (byBoundary.has(boundary)) {
      throw new InvalidServiceEnrollmentError(
        `duplicate space app-access entry for space "${boundary}"`,
      )
    }

    byBoundary.set(boundary, parseAccess(space, entry))
  }

  return { byBoundary }
}

/** Parse the `access` discriminator (+ `clientIds` for allowList) of an entry. */
function parseAccess(space: string, entry: RawSpaceAppAccess): AppAccess {
  const access = entry.access
  if (access === 'open') {
    return { kind: 'open' }
  }
  if (access === 'allowList') {
    const raw = entry.clientIds
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new InvalidServiceEnrollmentError(
        `space app-access "${space}" allowList must declare a non-empty "clientIds" array`,
      )
    }
    const clientIds: string[] = []
    for (const cid of raw) {
      if (typeof cid !== 'string' || cid.length === 0) {
        throw new InvalidServiceEnrollmentError(
          `space app-access "${space}" has an invalid client_id`,
        )
      }
      if (!isHttpsUrl(cid)) {
        throw new InvalidServiceEnrollmentError(
          `space app-access "${space}" client_id "${cid}" must be an https URL`,
        )
      }
      clientIds.push(cid)
    }
    return { kind: 'allowList', clientIds }
  }
  throw new InvalidServiceEnrollmentError(
    `space app-access "${space}" has invalid "access" (expected "open" or "allowList")`,
  )
}

/** Whether a string parses as a syntactically valid HTTPS URL. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Look up the app-access policy for a space URI. Any space with no explicit
 * entry (or an un-mappable URI) resolves to the default `#open` policy — so
 * unconfigured spaces are never accidentally gated.
 *
 * @param config - The validated app-access config (may be undefined ⇒ all open).
 * @param spaceUri - The three-component `ats://` space URI.
 * @param serviceDid - This service's DID (to map the URI to a boundary).
 * @returns The resolved {@link AppAccess} (defaults to `#open`).
 */
export function resolveAppAccess(
  config: SpaceAppAccessConfig | undefined,
  spaceUri: string,
  serviceDid: string,
): AppAccess {
  if (!config) return DEFAULT_APP_ACCESS
  const boundary = spaceUriToBoundary(spaceUri, serviceDid)
  if (!boundary.ok) return DEFAULT_APP_ACCESS
  return config.byBoundary.get(boundary.value) ?? DEFAULT_APP_ACCESS
}
