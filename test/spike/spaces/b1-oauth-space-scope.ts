/**
 * Spike B1 — will a PDS accept an OAuth space scope?
 *
 * The webapp must ask a spaces user's own PDS for permission to write space
 * records. This drives a Pushed Authorization Request, which is where a bad
 * scope is rejected, so it needs no browser.
 *
 * It runs the same request against a spaces PDS and two ordinary ones. If only
 * the spaces PDS accepts the scope, the PAR is a semantic capability probe and
 * is far better than the error-ordering probe recorded in the plan.
 *
 * Run from stratos-service: pnpm exec tsx ../test/spike/spaces/b1-oauth-space-scope.ts
 */
const REDIRECT_URI = 'http://127.0.0.1:8080/callback'
const AUTHORITY = 'did:web:stratos.test'
const SPACE_TYPE = 'zone.stratos.space.feed'
const COLLECTION = 'zone.stratos.feed.post'

const SPACE_SCOPE =
  `space:${SPACE_TYPE}` +
  `?authority=${AUTHORITY}` +
  `&skey=spike` +
  `&collection=${COLLECTION}` +
  `&action=create&action=read&action=update&action=delete`

const HOSTS = [
  { name: 'alpha spaces PDS', url: 'https://spaces-alpha.host.bsky.network' },
  { name: 'bsky.social', url: 'https://bsky.social' },
  { name: 'nihilist.cloud', url: 'https://nihilist.cloud' },
]

const log = (step: string, detail: unknown) =>
  console.log(`\n── ${step}\n`, detail)

/** Loopback client id, per the atproto OAuth profile for native clients. */
function loopbackClientId(scope: string): string {
  const params = new URLSearchParams({ redirect_uri: REDIRECT_URI, scope })
  return `http://localhost?${params.toString()}`
}

async function par(
  authServer: string,
  scope: string,
): Promise<{ status: number; body: unknown }> {
  const meta = await fetch(
    `${authServer}/.well-known/oauth-authorization-server`,
  ).then(
    (r) =>
      r.json() as Promise<{ pushed_authorization_request_endpoint: string }>,
  )

  const clientId = loopbackClientId(scope)
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope,
    state: 'spike-state',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  })

  const res = await fetch(meta.pushed_authorization_request_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  return { status: res.status, body }
}

async function main() {
  log('space scope under test', SPACE_SCOPE)

  const results: Record<string, { baseline: number; space: number }> = {}

  for (const host of HOSTS) {
    // Baseline: a scope every PDS understands, to separate "scope rejected"
    // from "this client shape is rejected".
    const baseline = await par(host.url, 'atproto').catch((e) => ({
      status: -1,
      body: String(e),
    }))
    const withSpace = await par(host.url, `atproto ${SPACE_SCOPE}`).catch(
      (e) => ({ status: -1, body: String(e) }),
    )

    log(host.name, {
      baselineStatus: baseline.status,
      baselineBody: summarize(baseline.body),
      spaceStatus: withSpace.status,
      spaceBody: summarize(withSpace.body),
    })
    results[host.name] = {
      baseline: baseline.status,
      space: withSpace.status,
    }
  }

  const alpha = results['alpha spaces PDS']
  const others = HOSTS.slice(1).map((h) => results[h.name])

  const alphaAccepts = alpha?.space === 201 || alpha?.space === 200
  const othersReject = others.every(
    (r) => r && r.space !== 201 && r.space !== 200,
  )
  const baselinesOk = [alpha, ...others].every(
    (r) => r && (r.baseline === 201 || r.baseline === 200),
  )

  console.log(`\n${'='.repeat(64)}`)
  console.log(`baselines all accepted:            ${baselinesOk}`)
  console.log(`spaces PDS accepts space scope:    ${alphaAccepts}`)
  console.log(`ordinary PDSs reject space scope:  ${othersReject}`)
  if (baselinesOk && alphaAccepts && othersReject) {
    console.log('RESULT: PASS — and PAR is a clean semantic capability probe.')
  } else if (alphaAccepts) {
    console.log(
      'RESULT: PARTIAL — the scope works, but PAR does not discriminate.',
    )
  } else {
    console.log('RESULT: FAIL — the spaces PDS did not accept the scope.')
  }
  console.log('='.repeat(64))
}

function summarize(body: unknown): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body)
  return s.length > 220 ? `${s.slice(0, 220)}…` : s
}

main().catch((err) => {
  console.error('spike failed:', err)
  process.exitCode = 1
})

/**
 * Follow-up probe: PAR only parks the request. The authorization endpoint is
 * where an unsupported scope surfaces. Exported for the second-pass script.
 */
export async function probeAuthorize(
  authServer: string,
  scope: string,
): Promise<{ status: number; location?: string; snippet: string }> {
  const parsed = await par(authServer, scope)
  const requestUri = (parsed.body as { request_uri?: string }).request_uri
  if (!requestUri) {
    return { status: parsed.status, snippet: summarize(parsed.body) }
  }
  const url = new URL(`${authServer}/oauth/authorize`)
  url.searchParams.set('client_id', loopbackClientId(scope))
  url.searchParams.set('request_uri', requestUri)
  const res = await fetch(url, { redirect: 'manual' })
  const text = await res.text().catch(() => '')
  return {
    status: res.status,
    location: res.headers.get('location') ?? undefined,
    snippet: text.slice(0, 300).replace(/\s+/g, ' '),
  }
}
