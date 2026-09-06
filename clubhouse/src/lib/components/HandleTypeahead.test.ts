import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
  searchActors: vi.fn(),
}))

vi.mock('../typeahead', () => ({
  searchActors: mocks.searchActors,
}))

import HandleTypeahead from './HandleTypeahead.svelte'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
  mocks.searchActors.mockReset()
})

describe('HandleTypeahead', () => {
  it.each(['Escape', 'blur'])(
    'keeps results closed after %s during a search',
    async (action) => {
      vi.useFakeTimers()
      let resolveSearch:
        | ((actors: Array<{ did: string; handle: string }>) => void)
        | undefined
      mocks.searchActors.mockReturnValue(
        new Promise((resolve) => {
          resolveSearch = resolve
        }),
      )
      const component = mount(HandleTypeahead, {
        target: document.body,
        props: { value: '' },
      })
      const input = document.querySelector<HTMLInputElement>('#handle')
      expect(input).not.toBeNull()
      input!.value = 'rei'
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
      await vi.advanceTimersByTimeAsync(180)

      if (action === 'Escape') {
        input!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )
      } else {
        input!.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
      }
      resolveSearch?.([{ did: 'did:plc:rei', handle: 'rei.example' }])
      await tick()

      expect(document.querySelector('#handle-suggestions')).toBeNull()
      unmount(component)
    },
  )
})
