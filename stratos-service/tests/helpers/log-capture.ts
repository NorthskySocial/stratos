import { inspect } from 'node:util'
import { expect, vi } from 'vitest'

const CONSOLE_METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const

function serialize(args: unknown[]): string {
  return inspect(args, {
    depth: Infinity,
    breakLength: Infinity,
    maxArrayLength: Infinity,
    maxStringLength: Infinity,
  })
}

/**
 * Runs one request and returns every entry written while it ran, serialized in
 * full: each call to any mocked method of `logger`, whatever its level, and each
 * console call, which the generic handler and middleware also use.
 */
export async function logsDuring<T>(
  logger: object,
  request: () => Promise<T>,
): Promise<{ result: T; entries: string[] }> {
  const levels = Object.values(logger).filter((value) =>
    vi.isMockFunction(value),
  )
  const callsBefore = levels.map((level) => level.mock.calls.length)
  const consoleSpies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  )
  try {
    const result = await request()
    const loggerEntries = levels.flatMap((level, index) =>
      level.mock.calls.slice(callsBefore[index]),
    )
    const consoleEntries = consoleSpies.flatMap((spy) => spy.mock.calls)
    return {
      result,
      entries: [...loggerEntries, ...consoleEntries].map(serialize),
    }
  } finally {
    for (const spy of consoleSpies) spy.mockRestore()
  }
}

/** An empty capture would pass vacuously, so at least one entry must exist. */
export function expectNoEntryContains(
  entries: string[],
  forbidden: string[],
): void {
  expect(entries.length).toBeGreaterThan(0)
  for (const value of forbidden) {
    expect(value).not.toBe('')
    expect(entries.filter((entry) => entry.includes(value))).toEqual([])
  }
}
