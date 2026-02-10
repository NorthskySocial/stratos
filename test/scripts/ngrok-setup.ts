#!/usr/bin/env -S deno run -A
import { startNgrok } from './lib/ngrok.ts'
import { section, info } from './lib/log.ts'

async function run() {
  section('Phase: Ngrok Setup')
  
  const useNgrok = Deno.env.get('USE_NGROK') === 'true'
  if (!useNgrok) {
    info('USE_NGROK not set to true, skipping ngrok setup')
    return
  }

  // Stratos service port is typically 3100 based on .env.example
  const port = parseInt(Deno.env.get('STRATOS_PORT') || '3100')
  await startNgrok(port)
}

run().catch((err) => {
  console.error('\nNgrok setup failed:', err)
  Deno.exit(1)
})
