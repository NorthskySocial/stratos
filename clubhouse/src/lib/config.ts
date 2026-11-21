import { parseSpaceUri } from '@northskysocial/stratos-client'
import { emptyDictionary } from './dictionary'

/** Public deployment settings injected by Vite at build time. */
export interface ClubhouseConfig {
  serviceUrl?: string
  serviceDid?: string
  feedgenUrl?: string
  feedgenDid?: string
  publicOrigin?: string
  roomStatusEndpoint?: string
  plcDirectoryUrl?: string
  /** Deployment-owned authority-space URIs keyed by public room ID. */
  pdsSpaceUriByRoom: Readonly<Record<string, string>>
  /** Why a room's configured space was refused, keyed by public room ID. */
  pdsSpaceProblemByRoom?: Readonly<Record<string, string>>
}

/** Return the public app origin used in OAuth metadata and service redirects. */
export function clubhouseBaseUrl(config: ClubhouseConfig): string {
  const configured = config.publicOrigin || window.location.origin
  return configured.replace(/\/+$/, '')
}

/** Build the only redirect URI Clubhouse hands to the enrollment service. */
export function clubhouseRedirectUri(config: ClubhouseConfig): string {
  return `${clubhouseBaseUrl(config)}/`
}

export function clubhouseClientId(config: ClubhouseConfig): string {
  return `${clubhouseBaseUrl(config)}/client-metadata.json`
}

interface ClubhouseEnvironment {
  VITE_STRATOS_URL?: string
  VITE_STRATOS_SERVICE_DID?: string
  VITE_FEEDGEN_URL?: string
  VITE_FEEDGEN_DID?: string
  VITE_CLUBHOUSE_URL?: string
  VITE_CLUBHOUSE_ROOM_STATUS_URL?: string
  VITE_PLC_DIRECTORY?: string
  VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON?: string
}

const FEEDGEN_SERVICE_FRAGMENT = '#stratos_feedgen'

/** Return the DID URL identifying the Feedgen service in its DID document. */
export function feedgenServiceId(feedgenDid: string): string {
  return feedgenDid.includes('#')
    ? feedgenDid
    : `${feedgenDid}${FEEDGEN_SERVICE_FRAGMENT}`
}

function optionalUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  return value.replace(/\/+$/, '')
}

function spaceProblem(roomId: string): string {
  return `Posting is not set up for the room "${roomId}": the space it was given is not a valid space address. Ask whoever runs this Clubhouse to correct it.`
}

function parseSpaceUris(
  value: string | undefined,
): Pick<ClubhouseConfig, 'pdsSpaceUriByRoom' | 'pdsSpaceProblemByRoom'> {
  const none = {
    pdsSpaceUriByRoom: emptyDictionary<string>(),
    pdsSpaceProblemByRoom: emptyDictionary<string>(),
  }
  if (!value) return none
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return none
    const spaces = emptyDictionary<string>()
    const problems = emptyDictionary<string>()
    // `JSON.parse` gives a `__proto__` key as an own property, so it is read
    // here as the room of that name.
    for (const [roomId, uri] of Object.entries(parsed)) {
      if (typeof uri === 'string' && parseSpaceUri(uri).ok) spaces[roomId] = uri
      else problems[roomId] = spaceProblem(roomId)
    }
    return { pdsSpaceUriByRoom: spaces, pdsSpaceProblemByRoom: problems }
  } catch {
    return none
  }
}

function serviceEndpoint(
  config: Pick<ClubhouseConfig, 'serviceUrl'>,
  path: string,
): string | undefined {
  if (!config.serviceUrl) return undefined
  return new URL(path, `${config.serviceUrl}/`).href
}

/** Resolve the public catalogue at the configured Stratos service. */
export function roomCatalogEndpoint(
  config: ClubhouseConfig,
): string | undefined {
  return serviceEndpoint(config, 'oauth/boundaries')
}

/** Resolve the boundary-free membership status endpoint at Stratos. */
export function roomStatusEndpoint(
  config: ClubhouseConfig,
): string | undefined {
  return (
    config.roomStatusEndpoint ??
    serviceEndpoint(config, 'oauth/boundaries/status')
  )
}

/** Resolve the server-approved Stratos-custody room writer. */
export function roomPostEndpoint(config: ClubhouseConfig): string | undefined {
  return serviceEndpoint(config, 'oauth/boundaries/post')
}

/** Read optional public deployment configuration without treating it as authority. */
export function loadClubhouseConfig(
  environment: ClubhouseEnvironment = import.meta.env as ClubhouseEnvironment,
): ClubhouseConfig {
  return {
    serviceUrl: optionalUrl(environment.VITE_STRATOS_URL),
    serviceDid: environment.VITE_STRATOS_SERVICE_DID,
    feedgenUrl: optionalUrl(environment.VITE_FEEDGEN_URL),
    feedgenDid: environment.VITE_FEEDGEN_DID,
    publicOrigin: optionalUrl(environment.VITE_CLUBHOUSE_URL),
    roomStatusEndpoint: optionalUrl(environment.VITE_CLUBHOUSE_ROOM_STATUS_URL),
    plcDirectoryUrl: optionalUrl(environment.VITE_PLC_DIRECTORY),
    ...parseSpaceUris(environment.VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON),
  }
}
