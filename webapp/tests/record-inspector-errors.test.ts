import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/svelte'
import type { OAuthSession } from '@atproto/oauth-client-browser'

const loader = vi.hoisted(() => ({ failures: 0 }))

vi.mock('../src/lib/inspector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/inspector')>()
  return {
    ...actual,
    loadInspectorRecord: vi.fn(
      async (...input: Parameters<typeof actual.loadInspectorRecord>) => {
        if (loader.failures > 0) {
          loader.failures -= 1
          throw new Error('The loader stopped.')
        }
        return actual.loadInspectorRecord(...input)
      },
    ),
  }
})

import RecordInspector from '../src/lib/RecordInspector.svelte'
import { createInspectorContext } from './helpers/inspector-context.svelte.js'

const SPIKE = 'did:plc:spikespiegel'
const SPACE = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
const OWN_POST = `${SPACE}/${SPIKE}/zone.stratos.feed.post/swordfish`
const CUSTODY_POST = `at://${SPIKE}/zone.stratos.feed.post/swordfish`

let publicRequests: string[]

function sessionAnswering(text: string) {
  const requests: string[] = []
  const session = {
    sub: SPIKE,
    fetchHandler: async (url: string) => {
      requests.push(url)
      return new Response(
        JSON.stringify({ uri: OWN_POST, cid: 'bafy-bebop', value: { text } }),
      )
    },
  } as unknown as OAuthSession
  return { session, requests }
}

function mountInspector(session: OAuthSession, uri: string) {
  render(RecordInspector, {
    props: { uri, cid: 'bafy-bebop', onclose: vi.fn() },
    context: new Map([
      [
        'stratos-inspector',
        createInspectorContext(session, 'https://stratos.example'),
      ],
    ]),
  })
}

beforeEach(() => {
  loader.failures = 0
  publicRequests = []
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    publicRequests.push(String(input))
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
})

describe('a loader that throws', () => {
  it('shows the own space error state with its retry, then reads on retry', async () => {
    loader.failures = 1
    const { session, requests } = sessionAnswering('Bang.')
    mountInspector(session, OWN_POST)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your record could not be read.',
    )
    expect(screen.getByText('Your record on your PDS')).toBeInTheDocument()
    expect(screen.queryByText('Public Record')).not.toBeInTheDocument()
    expect(requests).toEqual([])

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/Bang\./)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(requests).toHaveLength(1)
    expect(publicRequests).toEqual([])
  })

  it('shows the custody error state for a custody post', async () => {
    loader.failures = 1
    const { session, requests } = sessionAnswering('Bang.')
    mountInspector(session, CUSTODY_POST)

    expect(await screen.findByText('Public Record')).toBeInTheDocument()
    expect(screen.getByText('The loader stopped.')).toBeInTheDocument()
    expect(
      screen.queryByText('Your record on your PDS'),
    ).not.toBeInTheDocument()
    expect(requests).toEqual([])
    expect(publicRequests).toEqual([])
  })
})
