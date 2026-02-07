import pino from 'pino'
import type { Logger } from '@northskysocial/stratos-core'

export function createLogger(level: string): Logger {
  return pino({ level })
}
