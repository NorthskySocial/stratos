import { initializeTelemetry, parseTelemetryConfig } from './runtime.js'

const config = parseTelemetryConfig(process.env, 'stratos-service')
initializeTelemetry(config)
console.info(
  JSON.stringify({
    msg: 'telemetry initialized',
    service: 'stratos-service',
    sentryEnabled: config.sentryDsn !== undefined,
    environment: config.sentryEnvironment,
    releaseConfigured: config.sentryRelease !== undefined,
  }),
)
