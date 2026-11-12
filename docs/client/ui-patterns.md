---
audience: App developers and designers
type: Guide
status: current
---

# UI Patterns

A user must always know whether a post is public or private, and which
boundary will see it. These React patterns cover the common screens.

The components take plain props. They call the helpers from
[Creating Records](/client/creating-records) and
[Custody and Routing](/client/custody); they define no new API.

## Enrollment prompt

```tsx
interface EnrollmentPromptProps {
  handle: string
  onEnroll: (handle: string) => void
}

function StratosEnrollmentPrompt({ handle, onEnroll }: EnrollmentPromptProps) {
  return (
    <div className="enrollment-prompt">
      <h3>Enable Private Posts</h3>
      <p>Connect to Stratos to create posts visible only to your community.</p>
      <button onClick={() => onEnroll(handle)}>Enable Private Posts</button>
    </div>
  )
}
```

`onEnroll` starts the OAuth flow. See
[Initiating enrollment](/client/enrollment#initiating-enrollment).

## Boundary selector

A post belongs to exactly one boundary, so the selector is single-select:

```tsx
interface BoundarySelectorProps {
  boundaries: string[]
  selected: string
  onChange: (boundary: string) => void
}

function boundaryName(boundary: string): string {
  return boundary.slice(boundary.indexOf('/') + 1)
}

function BoundarySelector({
  boundaries,
  selected,
  onChange,
}: BoundarySelectorProps) {
  return (
    <div className="boundary-selector">
      <label htmlFor="boundary">Visible to:</label>
      <select
        id="boundary"
        value={selected}
        onChange={(event) => onChange(event.target.value)}
      >
        {boundaries.map((boundary) => (
          <option key={boundary} value={boundary}>
            {boundaryName(boundary)}
          </option>
        ))}
      </select>
    </div>
  )
}
```

`boundaries` holds the full values from the user's enrollment, such as
`did:web:stratos.example.com/general`. Show the short name. Send the full
value.

## Post composer with privacy toggle

The composer does not know about custody. It hands the text and the boundary
to a callback, and the callback routes the write:

```tsx
import { useState } from 'react'

interface ComposerProps {
  boundaries: string[]
  onPublicPost: (text: string) => Promise<void>
  onPrivatePost: (text: string, boundary: string) => Promise<void>
}

function StratosComposer({
  boundaries,
  onPublicPost,
  onPrivatePost,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [boundary, setBoundary] = useState(boundaries[0] ?? '')

  const canPost = text.trim() !== '' && (!isPrivate || boundary !== '')

  const handleSubmit = async () => {
    if (isPrivate) {
      await onPrivatePost(text, boundary)
    } else {
      await onPublicPost(text)
    }
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={
          isPrivate ? 'Write a private post...' : "What's happening?"
        }
      />

      <label>
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => setIsPrivate(event.target.checked)}
        />
        Private post
      </label>

      {isPrivate && (
        <BoundarySelector
          boundaries={boundaries}
          selected={boundary}
          onChange={setBoundary}
        />
      )}

      <button onClick={handleSubmit} disabled={!canPost}>
        {isPrivate ? 'Post privately' : 'Post'}
      </button>
    </div>
  )
}
```

`onPrivatePost` branches on the repository target. For `stratos` custody it
calls `com.atproto.repo.createRecord` on Stratos. For `pds` custody it calls
`com.atproto.space.createRecord` on the user's PDS. The
[Getting Started](/client/getting-started#_3-write-the-post) walk has that
function.

## Private post indicator

A feed mixes two URI shapes. A Stratos-hosted post has three segments and
starts with the author. A PDS-hosted post has seven and starts with the
authority. Do not read the author from the first segment. Take the author and
the boundary from the `zone.stratos.feedgen.getFeed` response instead. Each
post has `author.did`, `author.handle`, and `boundaries`:

```tsx
interface PostCardProps {
  text: string
  authorHandle: string
  // post.boundaries[0] from getFeed, or null for a public post.
  boundary: string | null
}

function PostCard({ text, authorHandle, boundary }: PostCardProps) {
  const isPrivate = boundary !== null

  return (
    <div className={isPrivate ? 'post private' : 'post'}>
      <div className="author">{authorHandle}</div>
      {isPrivate && (
        <div className="privacy-badge">Private: {boundaryName(boundary)}</div>
      )}
      <div className="content">{text}</div>
    </div>
  )
}
```

A PDS-hosted record carries no `boundary` field, and a boundary written by an
author is only a claim. That is why the badge uses the boundary the feed
generator reports.

## Recommended UX checklist

- Make private content visually distinct: a different background, a lock
  icon, a boundary badge.
- Preselect the user's first boundary in the composer.
- Disable the post button while a private post has no boundary.
- Show the enrollment prompt in place of the private composer when the user
  is not enrolled.
- Offer a private post to a `pds`-custody user only when the session holds
  the space scope. Ask them to sign in again when it is missing.
