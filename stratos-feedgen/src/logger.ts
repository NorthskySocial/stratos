import pino from 'pino'
import type { Logger } from '@northskysocial/stratos-core'

/**
 * Create a pino logger exposed through the stratos-core `Logger` interface so
 * modules depend on the interface, not on pino.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    formatters: {
      level: (label) => {
        return { level: label }
      },
    },
  })
}
