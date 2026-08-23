#!/usr/bin/env -S deno run -A
import { startNgrok } from './lib/ngrok.ts'
import { finish, section, skip } from './lib/log.ts'

async function run() {
  section('Phase: Ngrok Setup')

  const useNgrok = Deno.env.get('USE_NGROK') === 'true'
  if (!useNgrok) {
    skip('Ngrok setup', 'USE_NGROK not set to true')
    finish()
  }

  // Stratos service port is typically 3100 based on .env.example
  const port = parseInt(Deno.env.get('STRATOS_PORT') || '3100')
  await startNgrok(port)
  finish()
}

run().catch((err) => {
  console.error('\nNgrok setup failed:', err)
  Deno.exit(1)
})
