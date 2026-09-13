import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { verifySignature } from '@atproto/crypto'
import { createAttestationPayload } from '@northskysocial/stratos-core'
import express from 'express'
import { registerIdentityHandlers } from '../src/features/identity/handler.js'
import { openServiceSigningIdentity } from '../src/infra/signing/service-identity.js'
import * as mst from '../src/features/mst/init.js'
import type { AddressInfo } from 'node:net'
import { createAppContext } from '../src/context.js'
import { cborToRecord, createMockBlobStore, createTestConfig } from './utils'

describe('AppContext Refactoring', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-context-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should initialize AppContext using refactored factories (SQLite)', async () => {
    const cfg = createTestConfig(testDir)
    const ctx = await createAppContext({
      cfg,
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })

    expect(ctx).toBeDefined()
    expect(ctx.db).toBeDefined()
    expect(ctx.actorStore).toBeDefined()
    expect(ctx.enrollmentStore).toBeDefined()
    expect(ctx.idResolver).toBeDefined()
    expect(ctx.oauthClient).toBeDefined()
    expect(ctx.signingKey).toBeDefined()

    await ctx.destroy()
  })

  it('should have a working health check', async () => {
    const cfg = createTestConfig(testDir)
    const ctx = await createAppContext({
      cfg,
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })

    const health = await ctx.checkHealth()
    expect(health.status).toBe('ok')
    expect(health.components.db).toBe('ok')

    await ctx.destroy()
  })
})

it('serves the public history through XRPC and signs authenticated issue times', async () => {
  const dir = join(
    tmpdir(),
    `stratos-nerv-identity-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(dir)
  const cfg = createTestConfig(dir)
  const ctx = await createAppContext({
    cfg,
    blobstore: () => createMockBlobStore(),
    cborToRecord,
  })
  const app = express()
  registerIdentityHandlers(ctx.xrpcServer, ctx)
  app.use(ctx.xrpcServer.router)
  const listener = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve) => listener.once('listening', resolve))
    const response = await fetch(
      `http://127.0.0.1:${(listener.address() as AddressInfo).port}/xrpc/zone.stratos.identity.getKeyHistory`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ctx.keyHistory)
    expect(ctx.keyHistory.entries.at(-1)?.key).toBe(ctx.signingKey.did())
    const attestation = await ctx.createAttestation(
      'did:plc:shinji',
      ['did:web:nerv.example/engineering'],
      'did:key:zActor',
    )
    expect(attestation.signingKey).toBe(ctx.signingKey.did())
    expect(attestation.issuedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    )
    const payload = createAttestationPayload(
      'did:plc:shinji',
      ['did:web:nerv.example/engineering'],
      'did:key:zActor',
      attestation.issuedAt,
    )
    expect(
      await verifySignature(ctx.signingKey.did(), payload, attestation.sig),
    ).toBe(true)
    expect(
      await verifySignature(
        ctx.signingKey.did(),
        createAttestationPayload(
          'did:plc:shinji',
          ['did:web:nerv.example/engineering'],
          'did:key:zActor',
        ),
        attestation.sig,
      ),
    ).toBe(false)
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    )
    await ctx.destroy()
    const recovered = await openServiceSigningIdentity(dir, cfg.service.did)
    await recovered.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('releases the identity lock when OAuth initialization fails', async () => {
  const dir = join(
    tmpdir(),
    `stratos-nerv-failed-identity-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(dir)
  const cfg = createTestConfig(dir)
  cfg.service.publicUrl = 'invalid-url'
  try {
    await expect(
      createAppContext({
        cfg,
        blobstore: () => createMockBlobStore(),
        cborToRecord,
      }),
    ).rejects.toThrow()
    const recovered = await openServiceSigningIdentity(dir, cfg.service.did)
    await recovered.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('releases the identity lock when later service initialization fails', async () => {
  const dir = join(
    tmpdir(),
    `stratos-nerv-failed-services-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(dir)
  const cfg = createTestConfig(dir)
  const failure = new Error('NERV service initialization failed')
  const initialize = vi.spyOn(mst, 'initMst').mockImplementationOnce(() => {
    throw failure
  })
  try {
    await expect(
      createAppContext({
        cfg,
        blobstore: () => createMockBlobStore(),
        cborToRecord,
      }),
    ).rejects.toBe(failure)
    const recovered = await openServiceSigningIdentity(dir, cfg.service.did)
    await recovered.close()
  } finally {
    initialize.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})
