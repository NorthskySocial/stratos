/**
 * Boundary display helpers.
 *
 * A boundary is a service-qualified domain: `did:web:example.com/general`.
 * Operators think in terms of the trailing name, so lists and chips show that
 * alone; the full value is kept wherever the boundary must be identified
 * unambiguously (the Domains screen, and any raw editing surface).
 */

/**
 * The trailing name of a boundary, e.g. `general` for
 * `did:web:example.com/general`.
 * @param boundary - Full boundary value
 * @returns The trailing segment, or the input if it carries no service prefix
 */
export function boundaryName(boundary: string): string {
  const separator = boundary.lastIndexOf('/')
  if (separator === -1 || separator === boundary.length - 1) return boundary
  return boundary.slice(separator + 1)
}
