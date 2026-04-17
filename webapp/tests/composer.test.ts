import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/svelte'
import type { StratosEnrollment } from '../src/lib/stratos'
import Composer from '../src/lib/Composer.svelte'

describe('Composer.svelte', () => {
  const mockProps = {
    session: {
      sub: 'did:plc:alice',
      did: 'did:plc:alice',
      signOut: vi.fn(),
      getTokenInfo: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as any,
    enrollment: {
      service: 'did:web:stratos.ngrok.dev',
      boundaries: [{ value: 'did:web:stratos.ngrok.dev/example.com' }],
      signingKey: 'did:key:zQ3shj...',
      attestation: null,
      createdAt: new Date().toISOString(),
      rkey: 'example.com',
    } as StratosEnrollment,
    stratosAgent: {
      zone: {
        stratos: {
          repo: { uploadBlob: vi.fn(), createRecord: vi.fn() },
        },
      },
    } as unknown as {
      zone: {
        stratos: {
          repo: { uploadBlob: unknown; createRecord: unknown }
        }
      }
    },
    replyingTo: null,
    onpost: vi.fn(),
    oncancelreply: vi.fn(),
  }

  it('renders correctly', () => {
    render(Composer, { props: mockProps })
    expect(
      screen.getByPlaceholderText(/Post to example.com…/i),
    ).toBeInTheDocument()
    expect(screen.getByText('Post')).toBeInTheDocument()
  })

  it('toggles privacy', async () => {
    render(Composer, { props: mockProps })
    const toggle = screen.getByRole('checkbox', { name: /Private/i })
    expect(toggle).toBeChecked()

    await fireEvent.click(toggle)
    expect(toggle).not.toBeChecked()
  })
})
