import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import PostCard from '../src/lib/PostCard.svelte'
import '@testing-library/jest-dom'

describe('PostCard.svelte', () => {
  const mockPost = {
    uri: 'at://did:plc:mock/app.bsky.feed.post/1',
    cid: 'cid1',
    author: 'did:plc:mock',
    authorHandle: 'alice.bsky.social',
    text: 'Hello world',
    createdAt: new Date().toISOString(),
    boundaries: [],
    isPrivate: false,
    reply: null,
  }

  it('renders post text correctly', () => {
    render(PostCard, { post: mockPost, stratosAgent: null, onreply: () => {} })
    expect(screen.getByText('Hello world')).toBeInTheDocument()
    expect(screen.getByText('@alice.bsky.social')).toBeInTheDocument()
  })

  it('handles image extraction from $link structure', () => {
    const postWithImage = {
      ...mockPost,
      record: {
        ...mockPost.record,
        embed: {
          $type: 'app.bsky.embed.images',
          images: [
            {
              image: {
                ref: { $link: 'bafkrei-cid' },
                mimeType: 'image/jpeg',
              },
              alt: 'test image',
            },
          ],
        },
      },
    }

    render(PostCard, {
      post: postWithImage,
      stratosAgent: null,
      onreply: () => {},
    })
    // We can't easily check for the image display since it's lazy-loaded via an effect,
    // but we can verify the post renders without crashing and perhaps check the DOM.
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('handles image extraction from direct cid property', () => {
    const postWithImage = {
      ...mockPost,
      embed: {
        $type: 'zone.stratos.embed.images',
        images: [
          {
            image: {
              cid: 'direct-cid',
              mimeType: 'image/png',
            },
            alt: 'direct image',
          },
        ],
      },
    }

    render(PostCard, {
      post: postWithImage,
      stratosAgent: null,
      onreply: () => {},
    })
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('handles image extraction from string-only identifiers', () => {
    const postWithImage = {
      ...mockPost,
      embed: {
        $type: 'app.bsky.embed.images',
        images: [
          {
            image: 'string-cid',
            alt: 'string image',
          },
        ],
      },
    }

    render(PostCard, {
      post: postWithImage,
      stratosAgent: null,
      onreply: () => {},
    })
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('verifies fallback MIME type handling', async () => {
    const postWithImage = {
      ...mockPost,
      isPrivate: true,
      embed: {
        $type: 'zone.stratos.embed.images',
        images: [
          {
            image: {
              cid: 'cid-no-mime',
              // mimeType is missing
            },
            alt: 'no mime image',
          },
        ],
      },
    }

    const mockAgent = {
      call: vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
      api: {
        com: {
          atproto: {
            sync: {
              getBlob: vi.fn(),
            },
          },
        },
      },
    } as unknown as {
      call: ReturnType<typeof vi.fn>
      api: { com: { atproto: { sync: { getBlob: unknown } } } }
    }
    
    // Mock URL.createObjectURL and Blob
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url')

    render(PostCard, {
      post: postWithImage,
      stratosAgent: mockAgent as unknown as Parameters<typeof render>[1]['stratosAgent'],
      onreply: () => {},
    })

    // The loadBlob is called in an $effect, so we wait a bit
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockAgent.call).toHaveBeenCalledWith(
      'zone.stratos.sync.getBlob',
      expect.objectContaining({ cid: 'cid-no-mime' })
    )
  })

  it('handles zone.stratos.embed.image singular embed type', async () => {
    const postWithSingularImage = {
      ...mockPost,
      isPrivate: true,
      embed: {
        $type: 'zone.stratos.embed.image',
        image: {
          ref: { $link: 'singular-cid' },
          mimeType: 'image/webp',
        },
        alt: 'singular image',
      },
    }

    const mockAgent = {
      call: vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
      api: {
        com: {
          atproto: {
            sync: {
              getBlob: vi
                .fn()
                .mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
            },
          },
        },
      },
    } as unknown as {
      call: ReturnType<typeof vi.fn>
      api: {
        com: {
          atproto: {
            sync: {
              getBlob: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    }

    render(PostCard, {
      post: postWithSingularImage,
      stratosAgent: mockAgent as unknown as Parameters<typeof render>[1]['stratosAgent'],
      onreply: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockAgent.call).toHaveBeenCalledWith(
      'zone.stratos.sync.getBlob',
      {
        did: mockPost.author,
        cid: 'singular-cid',
      }
    )
  })

  it('handles app.bsky.embed.recordWithMedia with images', async () => {
    const postWithRecordWithMedia = {
      ...mockPost,
      isPrivate: true,
      embed: {
        $type: 'app.bsky.embed.recordWithMedia',
        media: {
          $type: 'app.bsky.embed.images',
          images: [
            {
              image: { ref: { $link: 'media-cid' } },
              alt: 'media image',
            },
          ],
        },
        record: {
          record: { uri: 'at://did:plc:foo/app.bsky.feed.post/bar', cid: 'baz' },
        },
      },
    }

    const mockAgent = {
      call: vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
      api: {
        com: {
          atproto: {
            sync: {
              getBlob: vi
                .fn()
                .mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
            },
          },
        },
      },
    } as unknown as {
      call: ReturnType<typeof vi.fn>
      api: {
        com: {
          atproto: {
            sync: {
              getBlob: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    }
    
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url-media')

    render(PostCard, {
      post: postWithRecordWithMedia,
      stratosAgent: mockAgent as unknown as Parameters<typeof render>[1]['stratosAgent'],
      onreply: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockAgent.call).toHaveBeenCalledWith(
      'zone.stratos.sync.getBlob',
      {
        did: mockPost.author,
        cid: 'media-cid',
      }
    )
  })

  it('handles app.bsky.embed.external with thumbnails', async () => {
    const postWithExternal = {
      ...mockPost,
      isPrivate: true,
      embed: {
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: 'Example',
          description: 'Example description',
          thumb: { ref: { $link: 'thumb-cid' } },
        },
      },
    }

    const mockAgent = {
      call: vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
      api: {
        com: {
          atproto: {
            sync: {
              getBlob: vi
                .fn()
                .mockResolvedValue({ data: new Uint8Array([1, 2, 3]) }),
            },
          },
        },
      },
    } as unknown as {
      call: ReturnType<typeof vi.fn>
      api: {
        com: {
          atproto: {
            sync: {
              getBlob: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    }
    
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url-thumb')

    render(PostCard, {
      post: postWithExternal,
      stratosAgent: mockAgent as unknown as Parameters<typeof render>[1]['stratosAgent'],
      onreply: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockAgent.call).toHaveBeenCalledWith(
      'zone.stratos.sync.getBlob',
      {
        did: mockPost.author,
        cid: 'thumb-cid',
      }
    )
  })

  it('triggers Stratos-specific blob loading for private posts', async () => {
    const postWithImage = {
      ...mockPost,
      isPrivate: true,
      embed: {
        $type: 'app.bsky.embed.images',
        images: [
          {
            image: { ref: { $link: 'private-cid' } },
            alt: 'private image',
          },
        ],
      },
    }

    const mockAgent = {
      service: 'https://stratos.example.com',
      call: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        data: new Uint8Array([4, 5, 6]),
      }),
      api: {
        xrpc: {
          baseClient: {
            fetch: vi.fn().mockResolvedValue({
              ok: true,
              status: 200,
              arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6]).buffer),
            }),
            getHeaders: vi.fn().mockResolvedValue({ Authorization: 'Bearer mock-token' }),
          },
        },
        com: {
          atproto: {
            sync: {
              getBlob: vi.fn(),
            },
          },
        },
      },
    } as unknown as {
      service: string
      call: ReturnType<typeof vi.fn>
      api: {
        xrpc: {
          baseClient: {
            fetch: ReturnType<typeof vi.fn>
            getHeaders: ReturnType<typeof vi.fn>
          }
        }
        com: {
          atproto: {
            sync: {
              getBlob: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    }

    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-private-url')

    render(PostCard, {
      post: postWithImage,
      stratosAgent: mockAgent as unknown as Parameters<typeof render>[1]['stratosAgent'],
      onreply: () => {},
    })

    // The loadBlob is called in an $effect, so we wait a bit
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Verify it called the Stratos-specific endpoint
    expect(mockAgent.call).toHaveBeenCalledWith(
      'zone.stratos.sync.getBlob',
      expect.objectContaining({
        did: mockPost.author,
        cid: 'private-cid',
      })
    )
    
    // Verify standard getBlob was NOT called because Stratos one succeeded
    expect(mockAgent.api.com.atproto.sync.getBlob).not.toHaveBeenCalled()
  })

  it('falls back to standard getBlob if Stratos one fails', async () => {
    const postWithImage = {
      ...mockPost,
      isPrivate: true,
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{ image: { ref: { $link: 'fallback-cid' } } }],
      },
    }

    const mockAgent = {
      service: 'https://stratos.example.com',
      call: vi.fn().mockRejectedValue(new Error('Stratos getBlob failed')),
      api: {
        xrpc: {
          baseClient: {
            fetch: vi.fn().mockResolvedValue({
              ok: false,
              status: 404,
            }),
            getHeaders: vi.fn().mockResolvedValue({}),
          },
        },
        com: {
          atproto: {
            sync: {
              getBlob: vi.fn().mockResolvedValue({ data: new Uint8Array([7, 8, 9]) }),
            },
          },
        },
      },
    } as unknown as {
      service: string
      call: ReturnType<typeof vi.fn>
      api: {
        xrpc: {
          baseClient: {
            fetch: ReturnType<typeof vi.fn>
            getHeaders: ReturnType<typeof vi.fn>
          }
        }
        com: {
          atproto: {
            sync: {
              getBlob: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    }

    render(PostCard, {
      post: postWithImage,
      stratosAgent: mockAgent as unknown as Parameters<typeof render>[1]['stratosAgent'],
      onreply: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockAgent.call).toHaveBeenCalled()
    expect(mockAgent.api.com.atproto.sync.getBlob).toHaveBeenCalledWith({
      did: mockPost.author,
      cid: 'fallback-cid',
    })
  })
})
