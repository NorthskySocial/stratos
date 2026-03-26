const QUALIFIED_BOUNDARY_SEPARATOR = '/'

/**
 * Qualify a bare boundary name with a service DID.
 *
 * @example qualifyBoundary('did:web:stratos.example.com', 'engineering')
 *          // => 'did:web:stratos.example.com/engineering'
 */
export function qualifyBoundary(serviceDid: string, name: string): string {
  return `${serviceDid}${QUALIFIED_BOUNDARY_SEPARATOR}${name}`
}

/**
 * Qualify an array of bare boundary names with a service DID.
 */
export function qualifyBoundaries(
  serviceDid: string,
  names: string[],
): string[] {
  return names.map((name) => qualifyBoundary(serviceDid, name))
}

/**
 * Check whether a boundary value is already in qualified form (contains a DID prefix).
 */
export function isQualifiedBoundary(value: string): boolean {
  return (
    value.startsWith('did:') && value.includes(QUALIFIED_BOUNDARY_SEPARATOR)
  )
}

/**
 * Parse a qualified boundary into its service DID and bare name.
 * Returns null if the value is not in qualified form.
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
