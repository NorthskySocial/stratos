import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { StratosEnrollment } from '../src/lib/stratos'
import { SPACE_WRITE_SCOPE } from '../src/lib/auth'
import Composer from '../src/lib/Composer.svelte'

const stratosCreateRecord = vi.fn().mockResolvedValue({})

function enrollment(custody: StratosEnrollment['custody']): StratosEnrollment {
  return {
    service: 'https://stratos.example',
    custody,
    boundaries: [{ value: 'did:web:stratos.example/nerve' }],
    signingKey: 'did:key:zQ3shjRei',
    attestation: null,
    createdAt: '1998-04-03T00:00:00.000Z',
    rkey: 'nerve',
  }
}

function session(scope = '') {
  return {
    sub: 'did:plc:faye',
    did: 'did:plc:faye',
    getTokenInfo: vi.fn().mockResolvedValue({ scope }),
    fetchHandler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
  }
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    session: session(),
    enrollment: enrollment('stratos'),
    attestationVerified: true,
    stratosAgent: {
      com: {
        atproto: {
          repo: { uploadBlob: vi.fn(), createRecord: stratosCreateRecord },
        },
      },
    },
    replyingTo: null,
    onpost: vi.fn(),
    oncancelreply: vi.fn(),
    ...overrides,
  }
}

describe('Composer.svelte', () => {
  it('renders a private Stratos composer', () => {
    render(Composer, { props: props() })

    expect(screen.getByPlaceholderText(/Post to nerve…/i)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Private/i })).toBeChecked()
  })

  it('unchecks and disables private mode when the attestation fails', async () => {
    render(Composer, { props: props({ attestationVerified: false }) })

    const toggle = screen.getByRole('checkbox', { name: /Private/i })
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(toggle).toBeDisabled()
  })

  it('does not fall back to a public post when private Stratos routing is unavailable', async () => {
    render(Composer, { props: props({ stratosAgent: null }) })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Faye holds the line.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    expect(
      screen.getByText(/Stratos service is not connected/i),
    ).toBeInTheDocument()
    expect(stratosCreateRecord).not.toHaveBeenCalled()
  })

  it('writes a private Stratos post with its boundary', async () => {
    const createRecord = vi.fn().mockResolvedValue({})
    const onpost = vi.fn()
    render(Composer, {
      props: props({
        stratosAgent: {
          com: { atproto: { repo: { uploadBlob: vi.fn(), createRecord } } },
        },
        onpost,
      }),
    })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Motoko checks the perimeter.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() => expect(createRecord).toHaveBeenCalledTimes(1))
    expect(createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'did:plc:faye',
        collection: 'zone.stratos.feed.post',
        record: expect.objectContaining({
          text: 'Motoko checks the perimeter.',
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: 'did:web:stratos.example/nerve' }],
          },
        }),
      }),
    )
    expect(onpost).toHaveBeenCalledTimes(1)
  })

  it('writes PDS-custody posts through the space endpoint without a boundary or embed', async () => {
    const pdsSession = session(SPACE_WRITE_SCOPE)
    render(Composer, {
      props: props({
        session: pdsSession,
        enrollment: enrollment('pds'),
        stratosAgent: null,
      }),
    })

    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: /Private/i }),
      ).not.toBeDisabled(),
    )
    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Rei keeps the record.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() =>
      expect(pdsSession.fetchHandler).toHaveBeenCalledTimes(1),
    )
    const [path, init] = pdsSession.fetchHandler.mock.calls[0]
    expect(path).toBe('/xrpc/com.atproto.space.createRecord')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({
        space:
          'at://did:web:stratos.example/space/zone.stratos.space.feed/nerve',
        repo: 'did:plc:faye',
        collection: 'zone.stratos.feed.post',
        validate: false,
        record: {
          $type: 'zone.stratos.feed.post',
          text: 'Rei keeps the record.',
          createdAt: expect.any(String),
        },
      }),
    )
    const body = JSON.parse(init.body)
    expect(body.record).not.toHaveProperty('boundary')
    expect(body.record).not.toHaveProperty('embed')
  })

  it('shows distinct guidance for a missing and an unavailable PDS space scope', async () => {
    const missing = render(Composer, {
      props: props({
        session: session(),
        enrollment: enrollment('pds'),
        stratosAgent: null,
      }),
    })
    await waitFor(() =>
      expect(
        screen.getByText(/requires a new space permission/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('checkbox', { name: /Private/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Private/i })).toBeDisabled()
    missing.unmount()

    render(Composer, {
      props: props({
        session: {
          ...session(),
          getTokenInfo: vi
            .fn()
            .mockRejectedValue(new Error('Misato lost the token')),
        },
        enrollment: enrollment('pds'),
        stratosAgent: null,
      }),
    })
    await waitFor(() =>
      expect(screen.getByText(/could not be verified/i)).toBeInTheDocument(),
    )
  })

  it('previews custody from the granted space scope before enrollment', async () => {
    const pdsPreview = render(Composer, {
      props: props({
        session: session(SPACE_WRITE_SCOPE),
        enrollment: null,
        attestationVerified: null,
        stratosAgent: null,
      }),
    })
    await waitFor(() =>
      expect(
        screen.getByText(
          /Your PDS will hold your private posts after enrollment/i,
        ),
      ).toBeInTheDocument(),
    )
    pdsPreview.unmount()

    render(Composer, {
      props: props({
        session: session(),
        enrollment: null,
        attestationVerified: null,
        stratosAgent: null,
      }),
    })
    await waitFor(() =>
      expect(
        screen.getByText(
          /Stratos will hold your private posts after enrollment/i,
        ),
      ).toBeInTheDocument(),
    )
  })

  it('shows an image preview for Stratos custody and blocks image selection for PDS custody', async () => {
    const { unmount } = render(Composer, { props: props() })
    const image = new File(['misa'], 'misato.png', { type: 'image/png' })
    await fireEvent.change(screen.getByLabelText(/🖼️/i), {
      target: { files: [image] },
    })
    await waitFor(() =>
      expect(screen.getByAltText('Preview')).toBeInTheDocument(),
    )
    unmount()

    render(Composer, {
      props: props({
        session: session(SPACE_WRITE_SCOPE),
        enrollment: enrollment('pds'),
        stratosAgent: null,
      }),
    })
    await waitFor(() =>
      expect(
        screen.getByText(
          /Images are not available for PDS-hosted private posts yet/i,
        ),
      ).toBeInTheDocument(),
    )
    expect(screen.getByLabelText(/🖼️/i)).toBeDisabled()
  })
})
