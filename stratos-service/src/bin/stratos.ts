#!/usr/bin/env node

import { main } from '../index.js'

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
