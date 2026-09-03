import { describe, expect, it, vi } from 'vitest'
import { resolveAuthenticatedHandle } from './enrollment'

describe('authenticated identity and enrollment discovery', () => {
  it('uses the signed-in PDS handle for a server enrollment request', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(new Response(JSON.stringify({ handle: 'hikaru.example' }), { status: 200 }))
    await expect(resolveAuthenticatedHandle({ sub: 'did:plc:hikaru', fetchHandler } as never)).resolves.toBe('hikaru.example')
    expect(fetchHandler).toHaveBeenCalledWith(
      expect.stringContaining('repo=did%3Aplc%3Ahikaru'),
      { method: 'GET' },
    )
  })
})
