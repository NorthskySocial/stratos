#!/usr/bin/env node

import { main } from '../index.js'

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err))
  if (err instanceof Error && err.stack) {
    console.error(err.stack)
  }
  process.exit(1)
})
