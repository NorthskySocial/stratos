#!/usr/bin/env -S deno run -A
import { startCloudflareTunnel } from './lib/cloudflare-tunnel.ts'
import { finish, section, skip } from './lib/log.ts'

async function run() {
  section('Phase: Cloudflare Tunnel Setup')

  const useCloudflareTunnel = Deno.env.get('USE_CLOUDFLARE_TUNNEL') === 'true'
  if (!useCloudflareTunnel) {
    skip('Cloudflare Tunnel setup', 'USE_CLOUDFLARE_TUNNEL is not set to true')
    finish()
  }

  await startCloudflareTunnel()
  finish()
}

run().catch((err) => {
  console.error('\nCloudflare Tunnel setup failed:', err)
  Deno.exit(1)
})
