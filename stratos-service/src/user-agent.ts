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

export function createFetchWithUserAgent(
  userAgent: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  return (input, init?) => {
    const headers = new Headers(init?.headers)
    headers.set('User-Agent', userAgent)
    return baseFetch(input, { ...init, headers })
  }
}
