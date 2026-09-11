import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { publicFetch } from '../src/network/public-fetch.js'
import { createPublicIdResolver } from '../src/network/identity.js'
import { StratosError } from '../src/shared/errors.js'

// Run with Deno's Node compatibility transport, as deployed by the indexer.
const server = createServer((_req, res) => res.end('{"secret":"Evangelion"}'))
let connections = 0
server.on('connection', () => {
  connections++
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const isBlocked = (error: unknown): boolean =>
  error instanceof TypeError &&
  error.cause instanceof StratosError &&
  error.cause.code === 'UnsafeOutboundAddress'
try {
  await assert.rejects(
    publicFetch(`https://localhost:${port}/`, {
      signal: AbortSignal.timeout(2000),
    }),
    isBlocked,
  )
  await assert.rejects(
    createPublicIdResolver().did.resolve(`did:web:localhost%3A${port}`),
    isBlocked,
  )
  assert.equal(connections, 0, 'SSRF attempts must not open an internal socket')
  console.log(
    'Deno SSRF checks passed: private DNS and DID hosts opened no sockets',
  )
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
