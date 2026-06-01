import { Buffer as BufferPolyfill } from 'buffer'

if (typeof window !== 'undefined') {
  interface CustomWindow extends Window {
    Buffer?: typeof BufferPolyfill
    process?: { env: Record<string, string | undefined> }
    performance: Performance
  }

  const customWindow = window as unknown as CustomWindow
  customWindow.Buffer = BufferPolyfill
  customWindow.process = customWindow.process || { env: {} }
  customWindow.performance = customWindow.performance || {
    now: () => Date.now(),
  }
}

import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

const app = mount(App, { target: document.getElementById('app')! })

export default app
