# UI Patterns

React/TSX component patterns for common Stratos interactions.

## Enrollment Prompt

```tsx
function StratosEnrollmentPrompt({ handle, onEnroll }) {
  return (
    <div className="enrollment-prompt">
      <h3>Enable Private Posts</h3>
      <p>Connect to Stratos to create posts visible only to your community.</p>
      <button onClick={() => onEnroll(handle)}>Enable Private Posts</button>
    </div>
  )
}
```

## Domain Selector

```tsx
function DomainSelector({ availableDomains, selected, onChange }) {
  return (
    <div className="domain-selector">
      <label>Visible to:</label>
      <select
        multiple
        value={selected}
        onChange={(e) =>
          onChange(Array.from(e.target.selectedOptions, (o) => o.value))
        }
      >
        {availableDomains.map((domain) => (
          <option key={domain} value={domain}>
            {domain}
          </option>
        ))}
      </select>
    </div>
  )
}
```

## Post Composer with Privacy Toggle

```tsx
function StratosComposer({ agent, stratosDomains }) {
  const [text, setText] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [selectedDomains, setSelectedDomains] = useState([])

  const handleSubmit = async () => {
    if (isPrivate) {
      await createPrivatePost(
        STRATOS_ENDPOINT,
        accessToken,
        agent.session.did,
        text,
        selectedDomains,
      )
    } else {
      await agent.post({ text })
    }
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          isPrivate ? 'Write a private post...' : "What's happening?"
        }
      />

      <div className="privacy-toggle">
        <label>
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          Private post
        </label>
      </div>

      {isPrivate && stratosDomains.length > 0 && (
        <DomainSelector
          availableDomains={stratosDomains}
          selected={selectedDomains}
          onChange={setSelectedDomains}
        />
      )}

      <button
        onClick={handleSubmit}
        disabled={isPrivate && selectedDomains.length === 0}
      >
        {isPrivate ? '🔒 Post' : 'Post'}
      </button>
    </div>
  )
}
```

## Private Post Indicator

```tsx
function PostCard({ post }) {
  const isStratos = post.uri.includes('zone.stratos.')
  const domains = post.record?.boundary?.values?.map((d) => d.value) ?? []

  return (
    <div className={`post ${isStratos ? 'private' : ''}`}>
      {isStratos && (
        <div className="privacy-badge">🔒 {domains.join(', ')}</div>
      )}
      <div className="content">{post.record.text}</div>
    </div>
  )
}
```

## Recommended UX Checklist

- Always make it visually clear when content is private (different background, lock icon, domain
  badges).
- Default to the user's first enrolled domain in the composer to reduce friction.
- Disable the post button when no domain is selected for a private post.
- Show an enrollment prompt before displaying the private post composer if the user isn't enrolled.
