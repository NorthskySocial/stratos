import './app.css'
import { initializeClubhouseTelemetry } from './telemetry'

initializeClubhouseTelemetry()

void bootstrap()

async function bootstrap(): Promise<void> {
  const [{ mount }, { default: App }] = await Promise.all([
    import('svelte'),
    import('./App.svelte'),
  ])

  const target = document.getElementById('app')
  if (!target) throw new Error('Clubhouse app target is missing')

  mount(App, { target })
}
