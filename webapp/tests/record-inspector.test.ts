import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/svelte'

import RecordInspector from '../src/lib/RecordInspector.svelte'

describe('RecordInspector.svelte', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
        this.dispatchEvent(new Event('close'))
      },
    })
  })

  it('closes when the dialog backdrop is clicked', async () => {
    const onclose = vi.fn()
    render(RecordInspector, {
      props: {
        uri: 'at://did:plc:rei/zone.stratos.feed.post/evangelion',
        onclose,
      },
    })

    const dialog = screen.getByRole('dialog')
    await fireEvent.click(dialog)

    expect(onclose).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveAttribute('open')
    expect(getComputedStyle(dialog).display).not.toBe('flex')
  })

  it('does not close when dialog content is clicked', async () => {
    const onclose = vi.fn()
    render(RecordInspector, {
      props: {
        uri: 'at://did:plc:asuka/zone.stratos.feed.post/lance',
        onclose,
      },
    })

    await fireEvent.click(
      screen.getByRole('heading', { name: 'Record Inspector' }),
    )

    expect(onclose).not.toHaveBeenCalled()
  })
})
