/**
 * Extract the friendly display name from a boundary value.
 * Qualified boundaries like "did:web:stratos.example.com/engineering" → "engineering"
 * Legacy bare names like "engineering" pass through unchanged.
 */
export function displayBoundary(boundary: string): string {
  if (boundary.startsWith('did:') && boundary.includes('/')) {
    const slashIndex = boundary.indexOf('/', boundary.indexOf(':', 4))
    if (slashIndex !== -1) {
      return boundary.slice(slashIndex + 1)
    }
  }
  return boundary
}
