import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createRecordMacHeaders,
  formatMacRequest,
  parseMacRequest,
  verifyRecordMac,
} from '@atproto/space'
import { suite } from './november-positive.js'

describe('November positive credential read', () => {
  it('requires the browser OAuth, MAC-verified credential read, feed and delete', () => {
    expect(suite.requiredAssertions).toEqual([
      'schema-grant',
      'oauth-create',
      'oauth-read',
      'authorized-feed',
      'credential-read',
      'oauth-delete',
    ])
  })

  it('bundles the SDK and runs the browser with its assets mounted', async () => {
    const scratchDirectory = await mkdtemp(join(tmpdir(), 'november-positive-'))
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed' as const,
    }))
    const runCommand = vi.fn(
      async (_file: string, _args: string[], _cwd: string) =>
        JSON.stringify({ suite: suite.id, assertions }),
    )
    try {
      const result = await suite.run({
        sandboxDirectory: '/sandbox',
        composeFile: '/sandbox/compose.yml',
        projectName: 'test',
        scratchDirectory,
        runCommand,
      })
      expect(result).toEqual(assertions)
      expect(runCommand).toHaveBeenCalledOnce()
      const args = runCommand.mock.calls[0][1] as string[]
      expect(args).toContain(
        `${join(scratchDirectory, 'standard-browser-assets')}:/scenario:ro,z`,
      )
      expect(args.slice(-2)).toEqual([
        'feedgen-e2e-browser',
        'november-positive',
      ])
      const sdk = await import(
        join(scratchDirectory, 'standard-browser-assets/sdk.mjs')
      )
      expect(typeof sdk.verifyRecordMac).toBe('function')
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true })
    }
  })

  it('rejects a record MAC for a different URI or CID', () => {
    const uri =
      'at:space/did:web:stratos.example/zone.stratos.space.feed/general/did:plc:alice/zone.stratos.feed.post/one'
    const cid = 'bafyreifwy2br6pte2mnzpfru7wmklqwe34ribjh53ccnuje65hq3onzori'
    const keyShare = 'did:key:zDnaeoA2SUkGYYDAVZBKgd4xWMGadgX2U29YPw8iEvCuELmfi'
    const sharedSecret = new Uint8Array(32).fill(7)
    const request = parseMacRequest(
      formatMacRequest('atproto-space-record', keyShare),
      'atproto-space-record',
    )!
    const { headers } = createRecordMacHeaders(uri, cid as never, {
      ...request,
      sharedSecret,
    })
    const verification = {
      keyShare,
      sharedSecret,
      headers: new Headers(headers),
    }
    expect(() => verifyRecordMac(uri, cid as never, verification)).not.toThrow()
    expect(() =>
      verifyRecordMac(`${uri}2`, cid as never, verification),
    ).toThrow()
    expect(() =>
      verifyRecordMac(uri, 'different' as never, verification),
    ).toThrow()
    verification.headers.set(
      'signature',
      'mac=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    )
    expect(() => verifyRecordMac(uri, cid as never, verification)).toThrow()
  })
})
