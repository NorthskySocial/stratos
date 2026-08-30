import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLogger } from '../src/index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createLogger', () => {
  it('applies the requested level', () => {
    const logger = createLogger('debug') as unknown as { level: string }
    expect(logger.level).toBe('debug')
  })

  it('serializes the level as a string label with the bound context', () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    const logger = createLogger('info')

    logger.info({ ship: 'bebop' }, 'gate to mars open')

    const line = write.mock.calls
      .map((call) => String(call[0]))
      .find((l) => l.includes('gate to mars open'))
    expect(line).toBeDefined()
    const parsed = JSON.parse(line as string) as Record<string, unknown>
    expect(parsed['level']).toBe('info')
    expect(parsed['ship']).toBe('bebop')
    expect(parsed['msg']).toBe('gate to mars open')
  })
})
