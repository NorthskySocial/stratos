import { TEST_ROOT } from './config.ts'
import { fail, info, pass, warn } from './log.ts'
import { loadState, saveState } from './state.ts'

export async function startNgrok(_port: number): Promise<string> {
  info('Starting ngrok via Docker Compose...')

  const cmd = new Deno.Command('docker-compose', {
    args: ['-f', 'docker-compose.test.yml', 'up', '-d', 'ngrok'],
    cwd: TEST_ROOT,
    stdout: 'piped',
    stderr: 'piped',
  })

  const { success, stderr } = await cmd.output()
  if (!success) {
    fail('Failed to start ngrok container', new TextDecoder().decode(stderr))
    throw new Error('ngrok container failed to start')
  }

  // Retrieve the public URL via the ngrok container's local API
  let url = ''
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch('http://localhost:4040/api/tunnels')
      const data = await resp.json()
      if (data.tunnels && data.tunnels.length > 0) {
        url = data.tunnels[0].public_url
        break
      }
    } catch {
      // Ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  if (!url) {
    fail('Failed to get ngrok public URL from container API')
    throw new Error('ngrok URL retrieval failed')
  }

  pass('ngrok started', url)

  const state = await loadState()
  state.ngrokUrl = url
  await saveState(state)

  return url
}

export async function stopNgrok(): Promise<void> {
  info('Stopping ngrok container...')
  const cmd = new Deno.Command('docker-compose', {
    args: ['-f', 'docker-compose.test.yml', 'stop', 'ngrok'],
    cwd: TEST_ROOT,
  })
  try {
    await cmd.output()
    pass('ngrok container stopped')
  } catch (err) {
    warn(`Failed to stop ngrok container: ${err}`)
  }
}
