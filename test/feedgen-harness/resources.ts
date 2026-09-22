import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REQUIRED_MEMORY_BYTES = 536_870_912

export interface CgroupLimits {
  cpuQuotaMicros: number | 'max'
  cpuPeriodMicros: number
  memoryBytes: number | 'max'
}

export interface ResourceGate {
  passed: boolean
  limits?: CgroupLimits
  reason?:
    | 'unavailable'
    | 'invalid'
    | 'unexpected-cpu-limit'
    | 'unexpected-memory-limit'
}

export interface CgroupUsage {
  memoryCurrentBytes: number
  memoryPeakBytes: number
  cpuUsageMicros: number
}

export interface ResourceMeasurement extends ResourceGate {
  usage?: CgroupUsage
}

/** Read cgroup v2 limits without guessing from host CPU/RAM. */
export async function inspectCgroupLimits(root: string): Promise<ResourceGate> {
  try {
    const [cpuMax, memoryMax] = await Promise.all([
      readFile(join(root, 'cpu.max'), 'utf8'),
      readFile(join(root, 'memory.max'), 'utf8'),
    ])
    const limits = parseCgroupLimits(cpuMax, memoryMax)
    if (!limits) return { passed: false, reason: 'invalid' }
    if (
      limits.cpuQuotaMicros === 'max' ||
      limits.cpuQuotaMicros !== limits.cpuPeriodMicros
    ) {
      return { passed: false, limits, reason: 'unexpected-cpu-limit' }
    }
    if (limits.memoryBytes !== REQUIRED_MEMORY_BYTES) {
      return { passed: false, limits, reason: 'unexpected-memory-limit' }
    }
    return { passed: true, limits }
  } catch {
    return { passed: false, reason: 'unavailable' }
  }
}

/** Read aggregate process-group accounting after the required limits pass. */
export async function inspectCgroupResources(
  root: string,
): Promise<ResourceMeasurement> {
  const gate = await inspectCgroupLimits(root)
  if (!gate.passed) return gate
  try {
    const [memoryCurrent, memoryPeak, cpuStat] = await Promise.all([
      readFile(join(root, 'memory.current'), 'utf8'),
      readFile(join(root, 'memory.peak'), 'utf8'),
      readFile(join(root, 'cpu.stat'), 'utf8'),
    ])
    const usage = parseCgroupUsage(memoryCurrent, memoryPeak, cpuStat)
    return usage
      ? { passed: true, limits: gate.limits, usage }
      : { passed: false, limits: gate.limits, reason: 'invalid' }
  } catch {
    return { passed: false, limits: gate.limits, reason: 'unavailable' }
  }
}

export function parseCgroupLimits(
  cpuMax: string,
  memoryMax: string,
): CgroupLimits | undefined {
  const [quota, period, ...extra] = cpuMax.trim().split(/\s+/)
  if (extra.length > 0 || !quota || !period) return undefined
  const cpuQuotaMicros = quota === 'max' ? 'max' : parsePositiveInteger(quota)
  const cpuPeriodMicros = parsePositiveInteger(period)
  const memoryValue = memoryMax.trim()
  const memoryBytes =
    memoryValue === 'max' ? 'max' : parsePositiveInteger(memoryValue)
  if (
    cpuQuotaMicros === undefined ||
    cpuPeriodMicros === undefined ||
    memoryBytes === undefined
  ) {
    return undefined
  }
  return { cpuQuotaMicros, cpuPeriodMicros, memoryBytes }
}

export function parseCgroupUsage(
  memoryCurrent: string,
  memoryPeak: string,
  cpuStat: string,
): CgroupUsage | undefined {
  const memoryCurrentBytes = parseNonNegativeInteger(memoryCurrent.trim())
  const memoryPeakBytes = parseNonNegativeInteger(memoryPeak.trim())
  const cpuUsageMicros = parseCpuUsageMicros(cpuStat)
  if (
    memoryCurrentBytes === undefined ||
    memoryPeakBytes === undefined ||
    cpuUsageMicros === undefined
  ) {
    return undefined
  }
  return { memoryCurrentBytes, memoryPeakBytes, cpuUsageMicros }
}

function parseCpuUsageMicros(value: string): number | undefined {
  const entries = value.trim().split(/\n/)
  const usage = entries.filter((entry) => entry.startsWith('usage_usec '))
  if (usage.length !== 1) return undefined
  return parseNonNegativeInteger(usage[0].slice('usage_usec '.length).trim())
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseNonNegativeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
