#!/usr/bin/env node
import { rotateServiceKey } from '../infra/signing/rotate-service-key.js'

await rotateServiceKey(process.argv.slice(2))
console.info(
  'Service signing key rotation recorded. Start Stratos with the same data directory.',
)
