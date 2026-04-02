/**
 * Build a user agent string for Stratos
 * @param version - The version of Stratos
 * @param repoUrl - The URL of the Stratos repository
 * @param operatorContact - Optional contact information for the operator
 * @returns The user agent string
 */
export function buildUserAgent(
  version: string,
  repoUrl: string,
  operatorContact?: string,
): string {
  const comment = operatorContact
    ? `(+${repoUrl}; ${operatorContact})`
    : `(+${repoUrl})`
  return `Stratos/${version} ${comment}`
}

/**
 * Create a fetch function with a user agent header
 * @param userAgent - The user agent string
 * @param baseFetch - The base fetch function to wrap (defaults to globalThis.fetch)
 * @returns A fetch function with the user agent header
 */
export function createFetchWithUserAgent(
  userAgent: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  return (input, init?) => {
    const existingHeaders = input instanceof Request ? input.headers : undefined
    const headers = new Headers(init?.headers ?? existingHeaders)
    headers.set('User-Agent', userAgent)
    return baseFetch(input, { ...init, headers })
  }
}
