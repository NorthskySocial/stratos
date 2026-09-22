import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectCgroupLimits,
  inspectCgroupResources,
  parseCgroupLimits,
  parseCgroupUsage,
} from './resources.js'

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

  it('returns aggregate cgroup usage only under the target resource envelope', async () => {
    const directory = await fixtureDirectory('100000 100000', '536870912')
    await Promise.all([
      writeFile(join(directory, 'memory.current'), '12345'),
      writeFile(join(directory, 'memory.peak'), '23456'),
      writeFile(join(directory, 'cpu.stat'), 'usage_usec 34567\nuser_usec 12'),
    ])
    await expect(inspectCgroupResources(directory)).resolves.toEqual({
      passed: true,
      limits: {
        cpuQuotaMicros: 100000,
        cpuPeriodMicros: 100000,
        memoryBytes: 536870912,
      },
      usage: {
        memoryCurrentBytes: 12345,
        memoryPeakBytes: 23456,
        cpuUsageMicros: 34567,
      },
    })
  })

  it('fails closed when required cgroup accounting is absent', async () => {
    const directory = await fixtureDirectory('100000 100000', '536870912')
    await expect(inspectCgroupResources(directory)).resolves.toEqual({
      passed: false,
      limits: {
        cpuQuotaMicros: 100000,
        cpuPeriodMicros: 100000,
        memoryBytes: 536870912,
      },
      reason: 'unavailable',
    })
  })

  it.each([
    ['missing usage', '12', '34', 'user_usec 12'],
    ['repeated usage', '12', '34', 'usage_usec 12\nusage_usec 13'],
    ['negative memory', '-1', '34', 'usage_usec 12'],
    ['overflowing peak', '12', '9007199254740992', 'usage_usec 12'],
  ])(
    'rejects malformed resource accounting: %s',
    (_name, memoryCurrent, memoryPeak, cpuStat) => {
      expect(
        parseCgroupUsage(memoryCurrent, memoryPeak, cpuStat),
      ).toBeUndefined()
    },
  )

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
