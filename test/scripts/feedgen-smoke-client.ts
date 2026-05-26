#!/usr/bin/env -S deno run -A
// Feed generator smoke test — Stratos client (WP2).
//
// Exercises `StratosClient.resolveEnrollments` against a live Stratos service
// using a configured feedgen signing key. Intended to be run as part of the
// E2E phase sequence after enrollment has completed, or manually against
// staging.
//
// Required env (see test/.env):
//   FEEDGEN_SERVICE_DID    e.g. did:web:feedgen.example.com
//   FEEDGEN_SIGNING_KEY    hex-encoded secp256k1 private key
//   STRATOS_SERVICE_URL    e.g. https://stratos.example.com
//   STRATOS_SERVICE_DID    e.g. did:web:stratos.example.com
//
// Optional: pass a target DID as argv[0]; otherwise the first enrolled test
// user from state.json is used.

import { Secp256k1Keypair } from 'npm:@atproto/crypto@^0.4.5'
import { createServiceJwt } from 'npm:@atproto/xrpc-server@^0.10.12'

import { loadState } from './lib/state.ts'
import { fail, info, pass, section, summary } from './lib/log.ts'

const LXM_RESOLVE = 'zone.stratos.identity.resolveEnrollments'

function requireEnv(key: string): string {
  const value = Deno.env.get(key)
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

async function main() {
  section('Feedgen smoke — StratosClient.resolveEnrollments')

  const feedgenDid = requireEnv('FEEDGEN_SERVICE_DID')
  const signingKeyHex = requireEnv('FEEDGEN_SIGNING_KEY')
  const stratosUrl = requireEnv('STRATOS_SERVICE_URL').replace(/\/$/, '')
  const stratosDid = requireEnv('STRATOS_SERVICE_DID')

  let targetDid = Deno.args[0]
  if (!targetDid) {
    const state = await loadState()
    const firstUser = Object.values(state.users ?? {})[0]
    if (!firstUser?.did) {
      throw new Error(
        'No target DID provided and no enrolled users in state.json',
      )
    }
    targetDid = firstUser.did
    info(`Using enrolled test user DID: ${targetDid}`)
  }

  const keypair = await Secp256k1Keypair.import(signingKeyHex)

  const jwt = await createServiceJwt({
    iss: feedgenDid,
    aud: stratosDid,
    lxm: LXM_RESOLVE,
    keypair,
  })

  const url = new URL(`${stratosUrl}/xrpc/${LXM_RESOLVE}`)
  url.searchParams.set('did', targetDid)

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text()
    fail(`resolveEnrollments failed`, `${res.status} ${body}`)
    summary(0, 1)
    Deno.exit(1)
  }

  const result = await res.json()
  pass(`resolveEnrollments → enrolled=${result.enrolled}`)
  info(`boundaries: ${JSON.stringify(result.boundaries)}`)
  summary(1, 0)
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    fail('smoke failed', String(err))
    Deno.exit(1)
  }
}
