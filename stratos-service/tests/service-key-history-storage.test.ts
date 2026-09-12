import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Secp256k1Keypair, type ExportableKeypair } from '@atproto/crypto'
import { openServiceSigningIdentity } from '../src/infra/signing/service-identity.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return {
    ...original,
    open: vi.fn(original.open),
    rename: vi.fn(original.rename),
    readFile: vi.fn(original.readFile),
    writeFile: vi.fn(original.writeFile),
  }
})
const original = await vi.importActual<typeof fs>('node:fs/promises')
const did = 'did:web:nerv.example'
let dir: string
beforeEach(async () => {
  vi.mocked(fs.open).mockReset().mockImplementation(original.open)
  vi.mocked(fs.rename).mockReset().mockImplementation(original.rename)
  vi.mocked(fs.readFile).mockReset().mockImplementation(original.readFile)
  vi.mocked(fs.writeFile).mockReset().mockImplementation(original.writeFile)
  dir = await original.mkdtemp(path.join(tmpdir(), 'stratos-nerv-atomic-'))
})
afterEach(async () => {
  await original.rm(dir, { recursive: true, force: true })
})

it('syncs the new bundle and parent directory, then closes their file handles', async () => {
  const handles: Array<{
    handle: fs.FileHandle
    sync: ReturnType<typeof vi.fn>
  }> = []
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await original.open(...args)
    if (!String(args[0]).endsWith('.lock')) {
      handles.push({ handle, sync: vi.spyOn(handle, 'sync') })
    }
    return handle
  })
  const identity = await openServiceSigningIdentity(dir, did)
  expect(handles).toHaveLength(2)
  for (const { handle, sync } of handles) {
    expect(sync).toHaveBeenCalledOnce()
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  }
  await identity.close()
})

it('closes the competing descriptor when acquiring the kernel lock fails', async () => {
  const identity = await openServiceSigningIdentity(dir, did)
  let competing: fs.FileHandle | undefined
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    competing = await original.open(...args)
    return competing
  })
  await expect(openServiceSigningIdentity(dir, did)).rejects.toThrow('flock')
  await expect(competing!.stat()).rejects.toMatchObject({ code: 'EBADF' })
  await expect(openServiceSigningIdentity(dir, did)).rejects.toThrow('flock')
  await identity.close()
  const recovered = await openServiceSigningIdentity(dir, did)
  await recovered.close()
})

it('keeps the committed identity and removes temporary files after a failed rename', async () => {
  const identity = await openServiceSigningIdentity(dir, did)
  const file = path.join(dir, 'service-signing-identity.json')
  const committed = await original.readFile(file)
  const next = await Secp256k1Keypair.create({ exportable: true })
  const failure = new Error('NERV disk rename failed')
  vi.mocked(fs.rename).mockRejectedValueOnce(failure)
  await expect(
    identity.rotate(
      next,
      new Date(
        Date.parse(identity.keyHistory.entries[0].validFrom) + 1,
      ).toISOString(),
    ),
  ).rejects.toBe(failure)
  expect(await original.readFile(file)).toEqual(committed)
  expect(
    (await original.readdir(dir)).some((file) => file.endsWith('.tmp')),
  ).toBe(false)
  await identity.close()
})

it('preserves a legacy key read error instead of attempting replacement', async () => {
  const failure = Object.assign(new Error('NERV key access denied'), {
    code: 'EACCES',
  })
  vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/signing_key')) throw failure
    return original.readFile(...args)
  })
  await expect(openServiceSigningIdentity(dir, did)).rejects.toBe(failure)
  expect(fs.writeFile).not.toHaveBeenCalled()
})

it('does not overwrite a legacy key created concurrently by provisioning', async () => {
  const rei = await Secp256k1Keypair.create({ exportable: true })
  const provisioned = await (rei as ExportableKeypair).export()
  vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
    await original.writeFile(args[0], provisioned)
    return original.writeFile(...args)
  })
  await expect(openServiceSigningIdentity(dir, did)).rejects.toMatchObject({
    code: 'EEXIST',
  })
  expect(await original.readFile(path.join(dir, 'signing_key'))).toEqual(
    Buffer.from(provisioned),
  )
})
