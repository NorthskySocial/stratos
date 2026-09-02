const targetRepo = process.env.FEEDGEN_E2E_TAMPER_COMMIT_REPO
const targetSpace = process.env.FEEDGEN_E2E_TAMPER_COMMIT_SPACE

if (!targetRepo || !targetSpace) {
  throw new Error('Missing the E2E commit tamper target')
}

const originalFetch = globalThis.fetch

globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init)
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  )
  if (
    url.pathname !== '/xrpc/com.atproto.space.listRepoOps' ||
    url.searchParams.get('repo') !== targetRepo ||
    url.searchParams.get('space') !== targetSpace ||
    !response.ok
  ) {
    return response
  }

  const body = await response.clone().json()
  if (!isRecord(body) || !isRecord(body.commit) || !isRecord(body.commit.mac)) {
    return response
  }
  const mac = body.commit.mac.$bytes
  if (typeof mac !== 'string' || mac.length === 0) {
    throw new Error('The PDS response has no signed commit MAC')
  }

  body.commit.mac = {
    $bytes: `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`,
  }
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
