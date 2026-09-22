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

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
