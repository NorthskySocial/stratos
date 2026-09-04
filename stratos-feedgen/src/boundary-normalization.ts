import {
  parseQualifiedBoundary,
  qualifyBoundary,
} from '@northskysocial/stratos-core'

export function normalizeMembershipBoundaries(
  serviceDid: string,
  boundaries: string[],
): string[] {
  return boundaries.flatMap((boundary) => {
    const parsed = parseQualifiedBoundary(boundary)
    if (parsed) {
      return parsed.serviceDid === serviceDid ? [boundary] : []
    }
    return [qualifyBoundary(serviceDid, boundary)]
  })
}
