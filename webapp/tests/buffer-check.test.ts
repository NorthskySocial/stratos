import { describe, it, expect } from 'vitest'
import { Agent } from '@atproto/api'
import { encode } from '@atcute/cbor'

describe('Buffer availability', () => {
  it('should have Buffer defined in the test environment', () => {
    // In Node.js environment (which Vitest uses by default), Buffer should be available.
    // This test checks if Buffer is available where Agent might use it.
    expect(typeof Buffer).not.toBe('undefined')
    expect(typeof Buffer.allocUnsafe).toBe('function')
  })

  it('Agent should be able to be instantiated without Buffer error', () => {
    // This is just a smoke test to see if importing/instantiating Agent triggers the error.
    // In many cases, the error happens at module load time or when a specific method is called.
    const agent = new Agent({ service: 'https://example.com' })
    expect(agent).toBeDefined()
  })

  it('should use @atcute/cbor without Buffer error', () => {
    const data = { hello: 'world' }
    const encoded = encode(data)
    expect(encoded).toBeDefined()
    expect(encoded instanceof Uint8Array).toBe(true)
  })

  it('global.Buffer should be available (simulating index.html script)', () => {
    // We already checked Buffer, but let's be explicit about it being on global
    expect(global.Buffer).toBeDefined()
  })

  it('Buffer.allocUnsafe should work as expected', () => {
    const buf = Buffer.allocUnsafe(10)
    expect(buf.length).toBe(10)
    // In jsdom environment, Buffer may not be a Uint8Array depending on node version and environment setup
    // But it should at least be an object with length and some bytes.
    expect(buf).toBeDefined()
  })
})
