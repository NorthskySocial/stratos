import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { StratosEnrollment } from '../src/lib/stratos'
import { SPACE_WRITE_SCOPE } from '../src/lib/auth'
import { Agent } from '@atproto/api'
import Composer from '../src/lib/Composer.svelte'
import { fetchStratosPosts, filterByDomain } from '../src/lib/feed'
import {
  startStratosResponder,
  type StratosResponder,
} from './helpers/stratos-responder'

let responder: StratosResponder

beforeAll(async () => {
  responder = await startStratosResponder()
})

afterAll(async () => {
  await responder.stop()
})

afterEach(() => {
  responder.requests.length = 0
  responder.respondWith(200, {})
})

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
    const stratosSession = responder.session(
      'did:plc:faye',
      'https://stratos.example',
    )
    responder.respondWith(200, {
      uri: 'at://did:plc:faye/zone.stratos.feed.post/3kmotoko',
      cid: 'bafyreimotoko',
    })
    const onpost = vi.fn()
    render(Composer, { props: props({ session: stratosSession, onpost }) })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Motoko checks the perimeter.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() => expect(responder.requests).toHaveLength(1))
    expect(responder.requests[0]).toEqual({
      method: 'POST',
      path: '/xrpc/zone.stratos.repo.createRecord',
      body: {
        boundary: 'did:web:stratos.example/nerve',
        repo: 'did:plc:faye',
        collection: 'zone.stratos.feed.post',
        record: {
          $type: 'zone.stratos.feed.post',
          text: 'Motoko checks the perimeter.',
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: 'did:web:stratos.example/nerve' }],
          },
          createdAt: expect.any(String),
        },
      },
    })
    await waitFor(() => expect(onpost).toHaveBeenCalledTimes(1))
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

  it('treats the local scope preview as advisory after enrollment', async () => {
    const missingScopeSession = session()
    const missing = render(Composer, {
      props: props({
        session: missingScopeSession,
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
      target: { value: 'Rei writes without trusting the preview.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))
    await waitFor(() =>
      expect(missingScopeSession.fetchHandler).toHaveBeenCalledTimes(1),
    )
    expect(missingScopeSession.getTokenInfo).not.toHaveBeenCalled()
    missing.unmount()

    const unavailableScopeSession = {
      ...session(),
      getTokenInfo: vi
        .fn()
        .mockRejectedValue(new Error('Misato lost the token')),
    }
    render(Composer, {
      props: props({
        session: unavailableScopeSession,
        enrollment: enrollment('pds'),
        stratosAgent: null,
      }),
    })
    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Asuka writes while token info is unavailable.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))
    await waitFor(() =>
      expect(unavailableScopeSession.fetchHandler).toHaveBeenCalledTimes(1),
    )
    expect(unavailableScopeSession.getTokenInfo).not.toHaveBeenCalled()
  })

  it('shows reauthorization guidance when the PDS rejects the space grant', async () => {
    const pdsSession = session(SPACE_WRITE_SCOPE)
    pdsSession.fetchHandler.mockResolvedValue(
      new Response('Missing required scope', { status: 403 }),
    )
    render(Composer, {
      props: props({
        session: pdsSession,
        enrollment: enrollment('pds'),
        stratosAgent: null,
      }),
    })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Rei needs a renewed grant.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() =>
      expect(
        screen.getByText(/requires a new space permission/i),
      ).toBeInTheDocument(),
    )
    expect(pdsSession.fetchHandler).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false')
  })

  it('clears the posting status after a post fails', async () => {
    responder.respondWith(500, {
      error: 'InternalServerError',
      message: 'Rin lost the uplink',
    })
    render(Composer, {
      props: props({
        session: responder.session('did:plc:faye', 'https://stratos.example'),
      }),
    })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Rin checks the uplink.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() =>
      expect(
        screen.getByText(/Could not create the post/i),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText('Creating post.')).not.toBeInTheDocument()
  })

  it('reports the character limit without marking service errors as text errors', async () => {
    const { unmount } = render(Composer, { props: props() })
    const textBox = screen.getByRole('textbox')
    await fireEvent.input(textBox, { target: { value: 'a'.repeat(280) } })
    expect(
      screen.getByText('20 characters remaining of 300.'),
    ).toBeInTheDocument()
    expect(textBox).toHaveAttribute('aria-invalid', 'false')
    unmount()

    render(Composer, { props: props() })
    const overLimitTextBox = screen.getByRole('textbox')
    await fireEvent.input(overLimitTextBox, {
      target: { value: 'a'.repeat(301) },
    })
    expect(
      screen.getByText('1 character over the 300-character limit.'),
    ).toBeInTheDocument()
    expect(overLimitTextBox).toHaveAttribute('aria-invalid', 'true')
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

  it('keeps the reply reference and the image embed in the Stratos record', async () => {
    const uploadBlob = vi.fn().mockResolvedValue({
      data: { blob: { ref: { $link: 'bafkreinerv' } } },
    })
    const stratosSession = responder.session(
      'did:plc:faye',
      'https://stratos.example',
    )
    const parent = {
      uri: 'at://did:plc:rei/zone.stratos.feed.post/3kparent',
      cid: 'bafyreiparent',
    }
    render(Composer, {
      props: props({
        session: stratosSession,
        stratosAgent: {
          com: { atproto: { repo: { uploadBlob, createRecord: vi.fn() } } },
        },
        replyingTo: {
          ...parent,
          text: 'Third Impact',
          createdAt: '1996-03-27T00:00:00Z',
          isPrivate: true,
          reply: null,
          author: 'did:plc:rei',
          authorHandle: 'rei.example',
          boundaries: ['did:web:stratos.example/nerve'],
        },
      }),
    })

    await fireEvent.change(screen.getByLabelText(/🖼️/i), {
      target: {
        files: [new File(['eva'], 'eva01.png', { type: 'image/png' })],
      },
    })
    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Unit 01 is berserk.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() => expect(responder.requests).toHaveLength(1))
    const { record } = responder.requests[0].body as {
      record: Record<string, unknown>
    }
    expect(record.reply).toEqual({ root: parent, parent })
    expect(record.embed).toMatchObject({ $type: 'zone.stratos.embed.images' })
    expect(record.boundary).toEqual({
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: 'did:web:stratos.example/nerve' }],
    })
  })

  it('writes a post the listRecords feed path reads back with its boundary', async () => {
    const agent = new Agent({ service: responder.origin })
    render(Composer, {
      props: props({
        session: responder.session('did:plc:faye', 'https://stratos.example'),
      }),
    })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Faye counts the cards.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))
    await waitFor(() => expect(responder.requests).toHaveLength(1))
    const { record } = responder.requests[0].body as { record: unknown }

    responder.respondWith(200, {
      records: [
        {
          uri: 'at://did:plc:faye/zone.stratos.feed.post/3kfaye',
          cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          value: record,
        },
      ],
    })
    const posts = await fetchStratosPosts(agent, 'did:plc:faye')

    expect(posts).toHaveLength(1)
    expect(posts[0].boundaries).toEqual(['did:web:stratos.example/nerve'])
    expect(filterByDomain(posts, 'did:web:stratos.example/nerve')).toHaveLength(
      1,
    )
  })

  it('writes to a Stratos service on a loopback http origin', async () => {
    responder.respondWith(200, {
      uri: 'at://did:plc:faye/zone.stratos.feed.post/3klocal',
      cid: 'bafyreilocal',
    })
    render(Composer, {
      props: props({
        session: responder.session('did:plc:faye', responder.origin),
        enrollment: { ...enrollment('stratos'), service: responder.origin },
      }),
    })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Ed hacks the local stack.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() => expect(responder.requests).toHaveLength(1))
    expect(responder.requests[0].path).toBe(
      '/xrpc/zone.stratos.repo.createRecord',
    )
  })

  it('sends nothing when the Stratos address is http on a host that is not loopback', async () => {
    const insecureSession = responder.session(
      'did:plc:faye',
      'http://stratos.example',
    )
    render(Composer, {
      props: props({
        session: insecureSession,
        enrollment: {
          ...enrollment('stratos'),
          service: 'http://stratos.example',
        },
      }),
    })

    await fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Ritsuko checks the origin.' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /Post$/ }))

    await waitFor(() =>
      expect(
        screen.getByText(/Could not create the post/i),
      ).toBeInTheDocument(),
    )
    expect(responder.requests).toEqual([])
    expect(insecureSession.fetchHandler).not.toHaveBeenCalled()
  })
})
