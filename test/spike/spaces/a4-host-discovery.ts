/**
 * Spike A4 — repo-host discovery.
 *
 * Upstream does not say how a syncer finds WHICH host holds a member's repo
 * for a space. `com.atproto.space.listRepos` returns only `{did, rev, hash}`,
 * and no space lexicon or table carries a host field. Stratos therefore sets
 * the convention:
 *
 *   1. An authority-recorded override, if Stratos has one for this member.
 *   2. Otherwise the `#atproto_pds` service endpoint in the member's DID
 *      document. This is the only convention upstream implies, though upstream
 *      applies it to notify targets rather than to repo hosts.
 *
 * This script exercises both arms against served DID documents. The resolver
 * below is the prototype for the pure module in `stratos-core/src/spaces/`.
 *
 * Run from stratos-service: pnpm exec tsx ../test/spike/spaces/a4-host-discovery.ts
 */
import { createServer } from 'node:http'
import { IdResolver } from '@atproto/identity'

const MEMBER_PORT = 3300
const MEMBER_DID = `did:web:localhost%3A${MEMBER_PORT}`
const MEMBER_PDS = 'http://localhost:3010'

/** How a repo host was determined. Worth surfacing in the admin interface. */
export type HostSource = 'authority-override' | 'did-document'

export interface ResolvedRepoHost {
  host: string
  source: HostSource
}

/** Reads a Stratos-recorded host override for a member of a space. */
export interface HostOverrideReader {
  get(spaceUri: string, memberDid: string): Promise<string | undefined>
}

/** Resolves the DID document service endpoint for a member. */
export interface DidPdsReader {
  getPdsEndpoint(memberDid: string): Promise<string | undefined>
}

/**
 * Resolve the repo host for one member of one space.
 *
 * The override wins so an operator can correct a member whose repo does not
 * live on the PDS named in their DID document.
 */
export async function resolveRepoHost(
  spaceUri: string,
  memberDid: string,
  deps: { overrides: HostOverrideReader; dids: DidPdsReader },
): Promise<ResolvedRepoHost | undefined> {
  const override = await deps.overrides.get(spaceUri, memberDid)
  if (override) return { host: override, source: 'authority-override' }

  const endpoint = await deps.dids.getPdsEndpoint(memberDid)
  if (endpoint) return { host: endpoint, source: 'did-document' }

  return undefined
}

const log = (step: string, detail: unknown) =>
  console.log(`\n── ${step}\n`, detail)

async function main() {
  const didDoc = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: MEMBER_DID,
    verificationMethod: [],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: MEMBER_PDS,
      },
    ],
  }

  const server = createServer((req, res) => {
    if (req.url === '/.well-known/did.json') {
      res.setHeader('content-type', 'application/did+ld+json')
      res.end(JSON.stringify(didDoc))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) =>
    server.listen(MEMBER_PORT, '0.0.0.0', resolve),
  )

  try {
    const idResolver = new IdResolver()
    const dids: DidPdsReader = {
      async getPdsEndpoint(did) {
        // A member whose document will not resolve must yield "unknown host",
        // never an exception. One unreachable member must not stop a sync pass.
        const doc = await idResolver.did.resolve(did).catch(() => undefined)
        const entry = doc?.service?.find(
          (s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`,
        )
        return typeof entry?.serviceEndpoint === 'string'
          ? entry.serviceEndpoint
          : undefined
      },
    }
    const spaceUri =
      'at://did:web:localhost%3A3100/space/zone.stratos.space.feed/spike'

    const viaDoc = await resolveRepoHost(spaceUri, MEMBER_DID, {
      overrides: {
        async get() {
          return undefined
        },
      },
      dids,
    })
    log('no override — resolved from the DID document', viaDoc)

    const viaOverride = await resolveRepoHost(spaceUri, MEMBER_DID, {
      overrides: {
        async get() {
          return 'http://host.example:9999'
        },
      },
      dids,
    })
    log('override present — override wins', viaOverride)

    const unknown = await resolveRepoHost(
      spaceUri,
      'did:web:localhost%3A3999',
      {
        overrides: {
          async get() {
            return undefined
          },
        },
        dids,
      },
    )
    log('unresolvable member', unknown)

    // The resolved host must actually be reachable and be a spaces PDS.
    let reachable = false
    let spacesCapable = false
    if (viaDoc) {
      const health = await fetch(`${viaDoc.host}/xrpc/_health`).catch(
        () => undefined,
      )
      reachable = health?.ok ?? false
      const probe = await fetch(
        `${viaDoc.host}/xrpc/com.atproto.space.getRecord`,
      ).catch(() => undefined)
      // A spaces PDS validates params and reports the missing key. A plain PDS
      // reports the method is not implemented.
      const body = probe ? await probe.text() : ''
      spacesCapable = body.includes('Missing required key')
      log('reachability and capability probe', {
        host: viaDoc.host,
        reachable,
        probeStatus: probe?.status,
        probeBody: body.slice(0, 120),
        spacesCapable,
      })
    }

    const pass =
      viaDoc?.source === 'did-document' &&
      viaOverride?.source === 'authority-override' &&
      unknown === undefined &&
      reachable &&
      spacesCapable

    console.log(`\n${'='.repeat(60)}`)
    console.log(
      pass
        ? 'RESULT: PASS — both arms resolve, and the host is a reachable spaces PDS.'
        : 'RESULT: FAIL — see the steps above.',
    )
    console.log('='.repeat(60))
    if (!pass) process.exitCode = 1
  } finally {
    server.close()
  }
}

main().catch((err) => {
  console.error('spike failed:', err)
  process.exitCode = 1
})
