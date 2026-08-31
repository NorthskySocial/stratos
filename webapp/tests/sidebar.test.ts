import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import Sidebar from '../src/lib/Sidebar.svelte'

describe('Sidebar.svelte', () => {
  it('shows PDS custody from the enrollment record and persistent attestation failure text', () => {
    render(Sidebar, {
      props: {
        handle: 'misato.example',
        enrollment: {
          service: 'https://stratos.example',
          custody: 'pds',
          boundaries: [{ value: 'did:web:stratos.example/nerve' }],
          signingKey: 'did:key:zQ3shjMisato',
          attestation: null,
          createdAt: '1995-10-04T00:00:00.000Z',
          rkey: 'nerve',
        },
        serviceUrl: 'https://stratos.example',
        stratosStatus: { enrolled: true },
        attestationVerified: false,
        allDomains: ['did:web:stratos.example/nerve'],
        enrolledDomains: ['did:web:stratos.example/nerve'],
        postCount: 3,
        userCount: 1,
        activeFeed: null,
        onSelectFeed: vi.fn(),
      },
    })

    expect(screen.getByText('Record custody')).toBeInTheDocument()
    expect(screen.getByText('PDS')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The enrollment attestation could not be verified. Private posting is disabled.',
    )
  })
})
