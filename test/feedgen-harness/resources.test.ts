import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectCgroupLimits, parseCgroupLimits } from './resources.js'

describe('cgroup resource gate', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true })),
    )
  })

  it.each([
    ['one CPU and 512 MiB', '100000 100000', '536870912', true],
    ['a different one-CPU period', '200000 200000', '536870912', true],
    ['under one CPU', '99999 100000', '536870912', false],
    ['unlimited CPU', 'max 100000', '536870912', false],
    ['over one CPU', '100001 100000', '536870912', false],
    ['under 512 MiB', '100000 100000', '536870911', false],
    ['over 512 MiB', '100000 100000', '536870913', false],
    ['unlimited memory', '100000 100000', 'max', false],
  ])('evaluates %s', async (_name, cpuMax, memoryMax, expected) => {
    const directory = await fixtureDirectory(cpuMax, memoryMax)
    expect((await inspectCgroupLimits(directory)).passed).toBe(expected)
  })

  it.each([
    ['missing period', '100000', '536870912'],
    ['non-numeric quota', 'many 100000', '536870912'],
    ['extra cpu token', '100000 100000 1', '536870912'],
    ['zero memory', '100000 100000', '0'],
  ])('rejects malformed limits: %s', (_name, cpuMax, memoryMax) => {
    expect(parseCgroupLimits(cpuMax, memoryMax)).toBeUndefined()
  })

  it('fails closed when cgroup files are absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedgen-cgroup-'))
    directories.push(directory)
    await expect(inspectCgroupLimits(directory)).resolves.toEqual({
      passed: false,
      reason: 'unavailable',
    })
  })

  it('fails closed when the cgroup root is inaccessible', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedgen-cgroup-'))
    directories.push(directory)
    const file = join(directory, 'not-a-directory')
    await writeFile(file, 'fixture')
    await expect(inspectCgroupLimits(file)).resolves.toEqual({
      passed: false,
      reason: 'unavailable',
    })
  })

  async function fixtureDirectory(
    cpuMax: string,
    memoryMax: string,
  ): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'feedgen-cgroup-'))
    directories.push(directory)
    await Promise.all([
      writeFile(join(directory, 'cpu.max'), cpuMax),
      writeFile(join(directory, 'memory.max'), memoryMax),
    ])
    return directory
  }
})
