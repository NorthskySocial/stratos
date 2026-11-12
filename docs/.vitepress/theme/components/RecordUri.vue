<template>
  <figure class="uri">
    <div class="uri-kinds" role="group" aria-label="Record address shape">
      <button
        v-for="option in KINDS"
        :key="option.kind"
        type="button"
        class="uri-kind"
        :aria-pressed="current === option.kind"
        @click="choose(option.kind)"
      >
        {{ option.label }}
      </button>
    </div>
    <p
      class="uri-row"
      role="group"
      :aria-label="`${labelOf(current)} segments`"
    >
      <button
        v-for="(segment, i) in segments"
        :key="`${current}-${i}`"
        type="button"
        class="uri-segment"
        :class="`role-${segment.role}`"
        :aria-pressed="i === selected"
        :aria-label="`${segment.name}: ${segment.text}`"
        @click="selected = i"
        @mouseenter="selected = i"
        @focus="selected = i"
      >
        {{ segment.text }}
      </button>
    </p>
    <figcaption class="uri-explain" aria-live="polite">
      <span class="uri-position">
        Segment {{ selected + 1 }} of {{ segments.length }}
      </span>
      <strong>{{ segments[selected].name }}</strong>
      <span>{{ segments[selected].detail }}</span>
    </figcaption>
    <details class="uri-all">
      <summary>Every segment, as a list</summary>
      <dl>
        <template v-for="segment in segments" :key="segment.name">
          <dt>
            <code>{{ segment.text }}</code> {{ segment.name }}
          </dt>
          <dd>{{ segment.detail }}</dd>
        </template>
      </dl>
    </details>
  </figure>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

type UriKind = 'space' | 'custody'

interface Segment {
  text: string
  name: string
  role: 'literal' | 'authority' | 'author' | 'path'
  detail: string
}

const props = withDefaults(defineProps<{ kind?: UriKind }>(), {
  kind: 'space',
})

const KINDS: { kind: UriKind; label: string }[] = [
  { kind: 'space', label: 'PDS custody: space record' },
  { kind: 'custody', label: 'Stratos custody: repo record' },
]

const SCHEME: Segment = {
  text: 'at://',
  name: 'Scheme',
  role: 'literal',
  detail: 'Every AT Protocol record address starts here.',
}
const COLLECTION: Segment = {
  text: '/zone.stratos.feed.post',
  name: 'Collection',
  role: 'path',
  detail: 'The record type.',
}
const RKEY: Segment = {
  text: '/3kq2xwmhefc2a',
  name: 'Record key',
  role: 'path',
  detail: "The record's key in the collection.",
}

const URIS: Record<UriKind, Segment[]> = {
  space: [
    SCHEME,
    {
      text: 'did:web:stratos.example.com',
      name: 'Authority DID',
      role: 'authority',
      detail:
        'The Stratos service that decides membership. It comes first, not the author. Code that reads the first segment as the author is wrong for this shape.',
    },
    {
      text: '/space',
      name: 'Space marker',
      role: 'literal',
      detail:
        'A literal segment where a collection NSID would sit. An NSID can never be the bare word space, so the two shapes cannot collide.',
    },
    {
      text: '/zone.stratos.space.feed',
      name: 'Space type',
      role: 'path',
      detail:
        'Must stay published as a com.atproto.lexicon.schema record. If it is missing, the PDS answers invalid_scope.',
    },
    {
      text: '/engineering',
      name: 'Space key',
      role: 'path',
      detail:
        'The boundary name. With the authority DID it is the boundary did:web:stratos.example.com/engineering.',
    },
    {
      text: '/did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      name: 'Author DID',
      role: 'author',
      detail:
        "The member who wrote the record, in segment five. The member's own PDS hosts the repository.",
    },
    COLLECTION,
    RKEY,
  ],
  custody: [
    SCHEME,
    {
      text: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      name: 'Author DID',
      role: 'author',
      detail:
        'For Stratos custody the author comes first, as on a public record. Stratos hosts the repository and signs commits with a per-actor P-256 key.',
    },
    {
      ...COLLECTION,
      detail:
        'The record type. The boundary is a field inside the record, checked by Stratos on write.',
    },
    RKEY,
  ],
}

const current = ref<UriKind>(props.kind)
const selected = ref(1)
const segments = computed(() => URIS[current.value])

function labelOf(kind: UriKind): string {
  return KINDS.find((k) => k.kind === kind)?.label ?? kind
}

function choose(kind: UriKind) {
  current.value = kind
  selected.value = 1
}
</script>

<style scoped>
.uri {
  margin: 1.5rem 0;
  padding: 16px;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.uri-kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.uri-kind {
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}
.uri-kind[aria-pressed='true'] {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-text-1);
}

.uri-row {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.uri-segment {
  padding: 2px 4px;
  border-radius: 4px;
  border-bottom: 2px solid var(--role);
  font: inherit;
  color: var(--vp-c-text-1);
  text-align: left;
  word-break: break-all;
}
.uri-segment[aria-pressed='true'] {
  background: var(--role-soft);
}
.uri-segment:focus-visible,
.uri-kind:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

.role-literal {
  --role: var(--vp-c-text-3);
  --role-soft: var(--vp-c-default-soft);
}
.role-authority {
  --role: var(--vp-c-brand-1);
  --role-soft: var(--vp-c-brand-soft);
}
.role-author {
  --role: var(--vp-c-warning-1);
  --role-soft: var(--vp-c-warning-soft);
}
.role-path {
  --role: var(--vp-c-divider);
  --role-soft: var(--vp-c-default-soft);
}

.uri-explain {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--vp-c-bg);
  font-size: 0.9rem;
}
.uri-position {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
}

.uri-all {
  margin-top: 10px;
  font-size: 0.85rem;
}
.uri-all summary {
  cursor: pointer;
  color: var(--vp-c-text-2);
}
.uri-all dl {
  margin: 8px 0 0;
}
.uri-all dd {
  margin: 0 0 6px 1rem;
  color: var(--vp-c-text-2);
}
</style>
