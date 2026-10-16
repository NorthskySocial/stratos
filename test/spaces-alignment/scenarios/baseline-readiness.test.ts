import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

type State = 'loading' | 'joined' | 'unjoined' | 'pending' | 'unavailable'
const labels: Record<State, string> = {
  loading: 'Checking access…',
  joined: 'Open room',
  unjoined: 'Join room',
  pending: 'Request pending…',
  unavailable: 'Joining unavailable',
}

async function probe(
  entry: string,
  final: State,
  routeFinal: State = 'unjoined',
  options: { privatePost?: boolean; composer?: boolean } = {},
) {
  const source = await readFile(
    new URL('../templates/feedgen-ng-e2e-browser.mjs', import.meta.url),
    'utf8',
  )
  const calls: string[] = []
  const waits: unknown[] = []
  let state: State = 'loading'
  let route = false
  let resolved = false
  const action = (name: string | RegExp) => {
    const matches = () =>
      typeof name === 'string'
        ? name === labels[state]
        : name.test(labels[state])
    return {
      isVisible: async () => !(route && state === 'joined') && matches(),
      click: async () => {
        assert.ok(resolved, 'Clicked before membership resolved')
        calls.push(labels[state])
      },
      waitFor: async (settings: unknown) => {
        waits.push(settings)
        await new Promise((resolve) => setTimeout(resolve, 5))
        state = route ? routeFinal : final
        resolved = true
        if (!matches()) throw new Error('private locator timeout details')
      },
    }
  }
  const scope = {
    waitFor: async () => calls.push('card-visible-while-loading'),
    getByRole: (
      role: string,
      { name, exact }: { name: string | RegExp; exact?: boolean },
    ) => {
      assert.equal(role, 'button')
      if (typeof name !== 'string') {
        assert.equal(name.test('Reopen Open room'), false)
        assert.equal(name.test('Join rooms'), false)
      } else if (
        !route &&
        (!resolved ||
          state === 'loading' ||
          state === 'pending' ||
          state === 'unavailable')
      ) {
        assert.equal(exact, true)
      }
      return action(name)
    },
  }
  const page = {
    locator: (selector: string) => {
      if (selector === '.room-card' || selector === '.room-view') return scope
      const locator = {
        first: () => locator,
        waitFor: async (settings: unknown) => {
          expect(selector).toBe(
            '.room-view .placeholder-panel, .room-view #room-post',
          )
          waits.push(settings)
          await new Promise((resolve) => setTimeout(resolve, 5))
          state = routeFinal
          resolved = true
          if (state === 'loading')
            throw new Error('private route timeout details')
        },
        isVisible: async () => {
          assert.ok(resolved, 'Asserted private access before resolution')
          return selector === '#room-post'
            ? (options.composer ?? false)
            : (options.privatePost ?? false)
        },
        innerText: async () => JSON.stringify({ success: true, did: 'motoko' }),
      }
      return locator
    },
    goto: async (url: string) => {
      if (url.includes('/rooms/')) {
        calls.push('room-route')
        route = true
        resolved = false
        state = 'loading'
      }
    },
    on: () => {},
  }
  const context = {
    assert,
    globalThis,
    Math,
    URL,
    Date,
    JSON,
    process: { env: {} },
    createRequire: () => () => ({
      chromium: {
        launch: async () => ({
          newPage: async () => page,
          close: async () => calls.push('closed'),
        }),
      },
    }),
    page,
    calls,
    fetch: async () => new Response(JSON.stringify({ feed: [] })),
  }
  const code = source
    .replace(/import\s+[\s\S]*?from\s*['"][^'"]+['"];?/g, '')
    .replace(/main\(\)\.catch\([\s\S]*$/, '')
  let error: string | undefined
  try {
    await runInNewContext(
      `${code}
      signIn = async () => {}
      completeOAuth = async () => { calls.push('oauth') }
      waitForComposer = async () => { calls.push('composer') }
      unjoinedOrdinaryAccount = async () => ({ did: 'motoko' })
      pdsEnrollment = async () => ({ boundaries: [{ value: 'did:web:stratos-e2e.sandbox.test/other' }] })
      pdsSession = async () => ({ accessJwt: 'not-a-token' })
      accountPdsUrl = () => 'https://pds.sandbox.test'
      ${entry}`,
      context,
    )
  } catch (caught) {
    error = (caught as Error).message
  }
  return { calls, waits, error }
}

const enter = "enterRoom(page, {}, 'https://clubhouse.sandbox.test', 'general')"
const denied =
  "assertNonmemberDenied('sandbox.test', 'https://clubhouse.sandbox.test', 'general', 'private-fixture')"

describe('baseline browser readiness using the executable template', () => {
  it.each(['joined', 'unjoined'] as const)(
    'waits through delayed membership before entering a %s room',
    async (state) => {
      const result = await probe(enter, state)
      expect(result.error).toBeUndefined()
      expect(result.waits).toEqual([{ state: 'visible', timeout: 30_000 }])
      expect(result.calls).toEqual(
        state === 'joined'
          ? ['card-visible-while-loading', 'Open room', 'composer']
          : ['card-visible-while-loading', 'Join room', 'oauth', 'composer'],
      )
    },
  )

  it('waits for both catalogue and direct-route access before denying private UI', async () => {
    const result = await probe(denied, 'unjoined')
    expect(result.error).toBeUndefined()
    expect(result.waits).toEqual([
      { state: 'visible', timeout: 30_000 },
      { state: 'visible', timeout: 30_000 },
    ])
    expect(result.calls).toEqual([
      'oauth',
      'card-visible-while-loading',
      'room-route',
      'closed',
    ])
  })

  it('rejects joined catalogue state instead of waiting for an unjoined state', async () => {
    const result = await probe(denied, 'joined')
    expect(result.error).toBe('Unjoined account was treated as a room member')
    expect(result.calls).toEqual([
      'oauth',
      'card-visible-while-loading',
      'closed',
    ])
    expect(result.waits).toHaveLength(1)
  })

  it('rejects joined direct-route state without accepting absence of content', async () => {
    const result = await probe(denied, 'unjoined', 'joined')
    expect(result.error).toBe(
      'Unjoined account was treated as a room member on the room route',
    )
    expect(result.calls).toContain('closed')
  })

  it('reports a bounded safe failure when direct-route access never resolves', async () => {
    const result = await probe(denied, 'unjoined', 'loading')
    expect(result.error).toBe('Room route access did not resolve')
    expect(result.waits).toEqual([
      { state: 'visible', timeout: 30_000 },
      { state: 'visible', timeout: 30_000 },
    ])
    expect(result.calls).toContain('closed')
  })

  it.each(['pending', 'unavailable'] as const)(
    'rejects resolved %s direct-route access',
    async (state) => {
      expect((await probe(denied, 'unjoined', state)).error).toBe(
        'Unjoined account was treated as a room member on the room route',
      )
    },
  )

  it.each([
    [{ privatePost: true }, 'Unjoined account saw a private room post'],
    [{ composer: true }, 'Unjoined account received a private room composer'],
  ] as const)(
    'retains strict private-access assertion %s',
    async (options, error) => {
      expect(
        (await probe(denied, 'unjoined', 'unjoined', options)).error,
      ).toContain(error)
    },
  )

  it.each(['loading', 'pending', 'unavailable'] as const)(
    'bounds unresolved %s state and reports only allowlisted UI booleans',
    async (state) => {
      const result = await probe(enter, state)
      expect(result.waits).toEqual([{ state: 'visible', timeout: 30_000 }])
      expect(result.calls).toEqual(['card-visible-while-loading'])
      expect(result.error).toBe(
        `Room action did not resolve: ${JSON.stringify(
          Object.fromEntries(
            [
              'Checking access…',
              'Open room',
              'Join room',
              'Request pending…',
              'Joining unavailable',
            ].map((label) => [label, label === labels[state]]),
          ),
        )}`,
      )
      expect(result.error).not.toContain('private locator timeout details')
    },
  )
})
