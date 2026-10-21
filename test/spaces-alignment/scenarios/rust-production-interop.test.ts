import { describe, expect, it, vi } from 'vitest'
import { suite } from './rust-production-interop.js'
import { suite as baseline } from './baseline.js'
import { validateAssertions } from '../rules.js'
import { copyFile } from 'node:fs/promises'

vi.mock('node:fs/promises', () => ({ copyFile: vi.fn() }))
vi.mock('./standard-credential-transport.js', () => ({
  prepareBrowserRunner: vi.fn(
    async () => '/tmp/faye-report/standard-browser-assets',
  ),
}))

const baselineReceipt = () =>
  JSON.stringify({
    suite: baseline.id,
    assertions: baseline.requiredAssertions.map((id) => ({
      id,
      status: 'passed',
    })),
  })
const expected = [
  'rust-manager-expiry-refresh',
  'rust-standard-exchange',
  'rust-stratos-read',
  'rust-october-pds-read',
  'rust-two-owners-one-host',
  'rust-wrong-owner-denied',
  'rust-wrong-key-denied',
  'rust-same-signature-reused',
  'rust-renewal-fresh-key',
  'rust-renewal-after-removal-denied',
]
const receipt = () => ({
  suite: 'rust-production-interop',
  assertions: expected.map((id) => ({ id, status: 'passed' })),
})
function context(
  probeOutput = JSON.stringify(receipt()),
  baselineOutput = baselineReceipt(),
) {
  return {
    sandboxDirectory: '/tmp/faye',
    composeFile: '/tmp/faye/compose.yaml',
    projectName: 'faye',
    scratchDirectory: '/tmp/faye-report',
    runCommand: vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'cargo') return ''
      return args.includes('FEEDGEN_E2E_PDS_ACCOUNT=batou')
        ? baselineOutput
        : probeOutput
    }),
  }
}

describe('Rust production interoperability', () => {
  it('requires actual Rust signing receipts in addition to production ingestion', async () => {
    const input = context('noise\n  ' + JSON.stringify(receipt()) + '\nnoise')
    expect(suite.requiredAssertions).toEqual([
      'rust-second-owner-ingestion',
      ...expected,
    ])
    const result = await suite.run(input)
    validateAssertions(suite, result)
    expect(result).toEqual([
      { id: 'rust-second-owner-ingestion', status: 'passed' },
      ...receipt().assertions,
    ])
    expect(input.runCommand.mock.calls[0]).toEqual([
      'docker',
      [
        'compose',
        '--file',
        input.composeFile,
        '--project-name',
        input.projectName,
        '--project-directory',
        input.sandboxDirectory,
        'run',
        '--build',
        '--rm',
        '--no-deps',
        '--env',
        'FEEDGEN_E2E_PDS_ACCOUNT=batou',
        'feedgen-e2e-browser',
      ],
      input.sandboxDirectory,
    ])
    expect(input.runCommand.mock.calls[1]).toEqual([
      'docker',
      [
        'compose',
        '--file',
        input.composeFile,
        '--project-name',
        input.projectName,
        '--project-directory',
        input.sandboxDirectory,
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        '/tmp/faye-report/standard-browser-assets:/scenario:ro,z',
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/rust-production-interop.driver.mjs',
      ],
      input.sandboxDirectory,
    ])
    expect(copyFile).toHaveBeenCalledWith(
      expect.stringContaining('/scenarios/rust-production-interop.driver.mjs'),
      '/tmp/faye-report/standard-browser-assets/rust-production-interop.driver.mjs',
    )
    expect(copyFile).toHaveBeenCalledWith(
      '/tmp/faye-report/standard-browser-assets/driver.mjs',
      '/tmp/faye-report/standard-browser-assets/standard-credential-transport.driver.mjs',
    )
  })
  it.each(['absent', 'skipped', 'failed', 'duplicate'])(
    'rejects %s Rust assertion evidence',
    async (failure) => {
      const value = receipt()
      if (failure === 'absent') value.assertions.pop()
      else if (failure === 'duplicate')
        value.assertions.push(value.assertions[0])
      else value.assertions[0].status = failure
      await expect(suite.run(context(JSON.stringify(value)))).rejects.toThrow()
    },
  )
  it('rejects absent receipt with an explicit diagnostic', async () => {
    await expect(suite.run(context('noise'))).rejects.toThrow(
      'Rust probe returned no assertion receipt',
    )
  })
  it.each([
    '{"suite":"rust-production-interop","assertions":{}}',
    JSON.stringify({
      ...receipt(),
      suite: 'rust-production-interop',
      assertions: receipt().assertions,
      extra: true,
    }).replace('"extra":true', '"suite":"wrong"'),
  ])('rejects malformed receipts %s', async (output) => {
    await expect(suite.run(context(output))).rejects.toThrow(
      'Rust probe returned an invalid assertion receipt',
    )
  })
  it('rejects missing baseline evidence before building the probe', async () => {
    const input = context(
      '',
      JSON.stringify({ suite: baseline.id, assertions: [] }),
    )
    await expect(suite.run(input)).rejects.toThrow()
    expect(input.runCommand).toHaveBeenCalledTimes(1)
  })
  it('propagates Rust build failures', async () => {
    const input = context()
    input.runCommand
      .mockImplementationOnce(async () => baselineReceipt())
      .mockRejectedValueOnce(new Error('build failed'))
    await expect(suite.run(input)).rejects.toThrow('build failed')
  })
})
