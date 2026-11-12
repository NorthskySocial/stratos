<template>
  <span class="term" @keydown.esc="dismiss">
    <button
      ref="trigger"
      type="button"
      class="term-trigger"
      :aria-describedby="entry ? popoverId : undefined"
    >
      <slot>{{ entry?.term ?? name }}</slot>
    </button>
    <span v-if="entry" :id="popoverId" role="tooltip" class="term-popover">
      <strong class="term-title">{{ entry.term }}</strong>
      <span class="term-definition">
        <template v-for="(part, i) in codeSpans(entry.definition)" :key="i">
          <code v-if="part.code">{{ part.text }}</code>
          <template v-else>{{ part.text }}</template>
        </template>
      </span>
      <a
        class="term-link"
        :href="withBase(`/reference/glossary#${entry.anchor}`)"
      >
        Glossary
      </a>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { withBase } from 'vitepress'
import { data as glossary } from '../../../reference/glossary.data'

const props = defineProps<{ name: string }>()

const trigger = ref<HTMLButtonElement | null>(null)
const popoverId = `term-${useId()}`

const entry = computed(() =>
  glossary.find((e) => e.slug === props.name.toLowerCase()),
)

function dismiss() {
  trigger.value?.blur()
}

function codeSpans(text: string): { text: string; code: boolean }[] {
  return text
    .split('`')
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((part) => part.text !== '')
}
</script>

<style scoped>
.term {
  position: relative;
  display: inline;
}

.term-trigger {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-decoration: underline dotted var(--vp-c-brand-1);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
  cursor: help;
}

.term-trigger:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
  border-radius: 2px;
}

.term-popover {
  position: absolute;
  left: 0;
  top: 100%;
  z-index: 20;
  display: none;
  width: min(20rem, 80vw);
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--vp-shadow-3);
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--vp-c-text-1);
  white-space: normal;
}

/* The popover is CSS-driven, so it works before hydration and without JS. */
.term:hover .term-popover,
.term:focus-within .term-popover {
  display: block;
}

.term-title {
  display: block;
  margin-bottom: 2px;
}

.term-link {
  display: inline-block;
  margin-top: 6px;
  font-weight: 600;
}
</style>
