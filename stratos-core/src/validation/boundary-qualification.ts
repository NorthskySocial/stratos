const QUALIFIED_BOUNDARY_SEPARATOR = '/'

/**
 * Qualify a bare boundary name with a service DID.
 *
 * @param serviceDid - The service DID to qualify the boundary for.
 * @param name - The bare boundary name to qualify.
 * @returns The qualified boundary string.
 * @example qualifyBoundary('did:web:stratos.example.com', 'engineering')
 *          // => 'did:web:stratos.example.com/engineering'
 */
export function qualifyBoundary(serviceDid: string, name: string): string {
  return `${serviceDid}${QUALIFIED_BOUNDARY_SEPARATOR}${name}`
}

/**
 * Qualify an array of bare boundary names with a service DID.
 *
 * @param serviceDid - The service DID to qualify the boundaries for.
 * @param names - The array of bare boundary names to qualify.
 * @returns The array of qualified boundary strings.
 */
export function qualifyBoundaries(
  serviceDid: string,
  names: string[],
): string[] {
  return names.map((name) => qualifyBoundary(serviceDid, name))
}

/**
 * Check whether a boundary value is already in qualified form (contains a DID prefix).
 *
 * @param value - The boundary value to check.
 * @returns True if the value is already qualified, false otherwise.
 */
export function isQualifiedBoundary(value: string): boolean {
  return (
    value.startsWith('did:') && value.includes(QUALIFIED_BOUNDARY_SEPARATOR)
  )
}

/**
 * Parse a qualified boundary into its service DID and bare name.
 * Returns null if the value is not in qualified form.
 *
 * @param qualified - The qualified boundary value to parse.
 * @returns An object containing the service DID and bare name, or null if parsing fails.
 */
export function parseQualifiedBoundary(
  qualified: string,
): { serviceDid: string; name: string } | null {
  if (!isQualifiedBoundary(qualified)) {
    return null
  }

  const separatorIndex = qualified.indexOf(
    QUALIFIED_BOUNDARY_SEPARATOR,
    qualified.indexOf(':', 4),
  )
  if (separatorIndex === -1) {
    return null
  }

  const serviceDid = qualified.slice(0, separatorIndex)
  const name = qualified.slice(separatorIndex + 1)

  if (!serviceDid || !name) {
    return null
  }

  return { serviceDid, name }
}

/**
 * Assert that a qualified boundary belongs to the given service DID.
 * Throws if the boundary's DID prefix does not match.
 *
 * @param boundary - The qualified boundary to check.
 * @param serviceDid - The service DID to check against.
 */
export function assertBoundaryMatchesService(
  boundary: string,
  serviceDid: string,
): void {
  const expectedPrefix = `${serviceDid}${QUALIFIED_BOUNDARY_SEPARATOR}`
  if (!boundary.startsWith(expectedPrefix)) {
    const parsed = parseQualifiedBoundary(boundary)
    const actualDid = parsed?.serviceDid ?? '(unqualified)'
    throw new BoundaryServiceMismatchError(boundary, serviceDid, actualDid)
  }
}

/**
 * Ensure all boundaries in the array are qualified for the given service.
 * Bare names are auto-qualified; already-qualified boundaries are validated.
 *
 * @param serviceDid - The service DID to qualify boundaries for.
 * @param boundaries - The array of boundaries to ensure are qualified.
 * @returns The array of qualified boundaries.
 */
export function ensureQualifiedBoundaries(
  serviceDid: string,
  boundaries: string[],
): string[] {
  return boundaries.map((b) => {
    if (isQualifiedBoundary(b)) {
      assertBoundaryMatchesService(b, serviceDid)
      return b
    }
    return qualifyBoundary(serviceDid, b)
  })
}

/**
 * Error thrown when a boundary does not belong to the expected service.
 */
export class BoundaryServiceMismatchError extends Error {
  public readonly code = 'ServiceMismatch'

  constructor(
    public readonly boundary: string,
    public readonly expectedServiceDid: string,
    public readonly actualServiceDid: string,
  ) {
    super(
      `Boundary "${boundary}" belongs to service ${actualServiceDid}, not ${expectedServiceDid}`,
    )
    this.name = 'BoundaryServiceMismatchError'
  }
}
