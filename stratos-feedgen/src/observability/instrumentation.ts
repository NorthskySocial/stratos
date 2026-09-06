import { initializeTelemetry, parseTelemetryConfig } from './runtime.js'

const config = parseTelemetryConfig(process.env, 'stratos-feedgen')
initializeTelemetry(config)
console.info(
  JSON.stringify({
    msg: 'telemetry initialized',
    service: 'stratos-feedgen',
    sentryEnabled: config.sentryDsn !== undefined,
    environment: config.sentryEnvironment,
    releaseConfigured: config.sentryRelease !== undefined,
  }),
)
