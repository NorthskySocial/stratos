import { TEST_ROOT } from './config.ts'
import { fail, info, pass } from './log.ts'
import { loadState, saveState } from './state.ts'

const COMPOSE_FILE = 'docker-compose.test.yml'
const TUNNEL_SERVICE = 'cloudflared'
const TUNNEL_CREATED_MESSAGE = 'Your quick Tunnel has been created!'
const TUNNEL_URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/

export function extractTunnelUrl(output: string): string | undefined {
  const createdMessageIndex = output.lastIndexOf(TUNNEL_CREATED_MESSAGE)
  if (createdMessageIndex === -1) return undefined
  return output.slice(createdMessageIndex).match(TUNNEL_URL_PATTERN)?.[0]
}

export async function startCloudflareTunnel(): Promise<string> {
  info('Starting Cloudflare Tunnel via Docker Compose...')

  const start = new Deno.Command('docker-compose', {
    args: ['-f', COMPOSE_FILE, 'up', '-d', '--force-recreate', TUNNEL_SERVICE],
    cwd: TEST_ROOT,
    stdout: 'piped',
    stderr: 'piped',
  })

  const startResult = await start.output()
  if (!startResult.success) {
    fail(
      'Failed to start the Cloudflare Tunnel container',
      new TextDecoder().decode(startResult.stderr),
    )
    throw new Error('Cloudflare Tunnel container failed to start')
  }

  let url = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const logs = new Deno.Command('docker-compose', {
      args: ['-f', COMPOSE_FILE, 'logs', '--no-color', TUNNEL_SERVICE],
      cwd: TEST_ROOT,
      stdout: 'piped',
      stderr: 'piped',
    })
    const logResult = await logs.output()
    const output = `${new TextDecoder().decode(logResult.stdout)}\n${new TextDecoder().decode(logResult.stderr)}`
    const tunnelUrl = extractTunnelUrl(output)
    if (tunnelUrl) {
      url = tunnelUrl
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }

  if (!url) {
    fail('Failed to get the Cloudflare Tunnel public URL from container logs')
    throw new Error('Cloudflare Tunnel URL retrieval failed')
  }

  pass('Cloudflare Tunnel started', url)

  const state = await loadState()
  state.tunnelUrl = url
  await saveState(state)

  return url
}

export async function stopCloudflareTunnel(): Promise<void> {
  info('Stopping the Cloudflare Tunnel container...')
  const stop = new Deno.Command('docker-compose', {
    args: ['-f', COMPOSE_FILE, 'stop', TUNNEL_SERVICE],
    cwd: TEST_ROOT,
  })
  try {
    const result = await stop.output()
    if (!result.success) {
      fail(
        'Failed to stop the Cloudflare Tunnel container',
        new TextDecoder().decode(result.stderr),
      )
      return
    }

    const state = await loadState()
    delete state.tunnelUrl
    await saveState(state)
    pass('Cloudflare Tunnel container stopped')
  } catch (err) {
    fail('Failed to stop the Cloudflare Tunnel container', String(err))
  }
}
