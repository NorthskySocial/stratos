/**
 * Spike B1b — does the AUTHORIZATION endpoint accept a space scope?
 *
 * A Pushed Authorization Request only parks the parameters; spike B1 showed
 * every PDS returns 201 there, so PAR proves nothing. The authorization
 * endpoint is where an unsupported scope is reported. This script reads the
 * real error out of the response instead of judging by status code alone.
 *
 * Run from stratos-service: pnpm exec tsx ../test/spike/spaces/b1b-authorize-probe.ts
 */
const REDIRECT_URI = 'http://127.0.0.1:8080/callback'
const SPACE_SCOPE =
  'space:zone.stratos.space.feed?authority=did:web:stratos.test&skey=spike' +
  '&collection=zone.stratos.feed.post&action=create&action=read'

const HOSTS = [
  ['alpha spaces PDS', 'https://spaces-alpha.host.bsky.network'],
  ['bsky.social', 'https://bsky.social'],
  ['nihilist.cloud', 'https://nihilist.cloud'],
] as const

function loopbackClientId(scope: string): string {
  const params = new URLSearchParams({ redirect_uri: REDIRECT_URI, scope })
  return `http://localhost?${params.toString()}`
}

/** The provider renders errors into a JSON blob inside the HTML shell. */
function extractError(html: string): string {
  // Parse the provider's error blob as one object. Two independent regexes
  // can pair an `error` from one place with a `description` from another.
  const blob = html.match(/window\["__errorData"\]=JSON\.parse\("(.*?)"\);/)
  if (blob?.[1]) {
    try {
      const parsed: unknown = JSON.parse(JSON.parse(`"${blob[1]}"`))
      if (typeof parsed === 'object' && parsed !== null) {
        const { error, error_description: desc } = parsed as {
          error?: string
          error_description?: string
        }
        if (error) return desc ? `${error}: ${desc}` : error
      }
    } catch {
      // Fall through to the title.
    }
  }
  const title = html.match(/<title>([^<]*)<\/title>/)
  return title?.[1]?.trim() || html.slice(0, 160).replace(/\s+/g, ' ')
}

async function probe(authServer: string, scope: string) {
  const meta = (await fetch(
    `${authServer}/.well-known/oauth-authorization-server`,
  ).then((r) => r.json())) as {
    pushed_authorization_request_endpoint: string
    authorization_endpoint: string
  }

  const clientId = loopbackClientId(scope)
  const parRes = await fetch(meta.pushed_authorization_request_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope,
      state: 'spike',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    }).toString(),
  })
  const parBody = (await parRes.json()) as {
    request_uri?: string
    error?: string
    error_description?: string
  }
  if (!parBody.request_uri) {
    return {
      stage: 'par',
      status: parRes.status,
      detail: `${parBody.error}: ${parBody.error_description}`,
    }
  }

  const url = new URL(meta.authorization_endpoint)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('request_uri', parBody.request_uri)
  const res = await fetch(url, { redirect: 'manual' })
  const text = await res.text().catch(() => '')
  return {
    stage: 'authorize',
    status: res.status,
    detail: res.status >= 400 ? extractError(text) : 'rendered a consent page',
  }
}

async function main() {
  console.log('space scope:', SPACE_SCOPE, '\n')
  for (const [name, url] of HOSTS) {
    const base = await probe(url, 'atproto').catch((e) => ({
      stage: 'error',
      status: -1,
      detail: String(e),
    }))
    const spaced = await probe(url, `atproto ${SPACE_SCOPE}`).catch((e) => ({
      stage: 'error',
      status: -1,
      detail: String(e),
    }))
    console.log(`=== ${name}`)
    console.log(
      `  atproto only : [${base.stage} ${base.status}] ${base.detail}`,
    )
    console.log(
      `  + space scope: [${spaced.stage} ${spaced.status}] ${spaced.detail}`,
    )
    console.log()
  }
}

main().catch((err) => {
  console.error('spike failed:', err)
  process.exitCode = 1
})
