import pino from 'pino'
import type { Logger } from '@northskysocial/stratos-core'

/**
 * Create a logger instance with specified log level
 *
 * @param level - Log level for the logger
 * @returns Logger instance
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    mixin(_context, level) {
      return { level: pino.levels.labels[level] }
    },
    formatters: {
      level: (label) => {
        return { level: label }
      },
    },
  })
}
