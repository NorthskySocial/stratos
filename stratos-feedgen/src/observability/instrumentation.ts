import { initializeTelemetry, parseTelemetryConfig } from './runtime.js'
initializeTelemetry(parseTelemetryConfig(process.env, 'stratos-feedgen'))
