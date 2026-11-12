<template>
  <section class="feedback" aria-labelledby="feedback-question">
    <p id="feedback-question" class="feedback-question">
      Was this page helpful?
    </p>
    <div class="feedback-actions">
      <button
        type="button"
        class="feedback-button"
        :aria-pressed="answer === 'yes'"
        @click="answer = 'yes'"
      >
        Yes
      </button>
      <a
        class="feedback-button"
        :href="issueUrl"
        target="_blank"
        rel="noopener"
        @click="answer = 'no'"
      >
        No, tell us why
      </a>
    </div>
    <p v-if="answer === 'yes'" class="feedback-thanks" role="status">
      Thank you.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useData } from 'vitepress'

const ISSUE_URL = 'https://github.com/NorthskySocial/stratos/issues/new'

// Nothing is recorded or sent. "No" only opens a prefilled GitHub issue.
const answer = ref<'yes' | 'no' | null>(null)
const { page } = useData()

const issueUrl = computed(() => {
  const params = new URLSearchParams({
    title: `Docs feedback: ${page.value.title}`,
    body: `Page: ${page.value.relativePath}\n\nWhat was missing or unclear?\n`,
  })
  return `${ISSUE_URL}?${params}`
})
</script>

<style scoped>
.feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-top: 48px;
  padding: 12px 0;
  border-top: 1px solid var(--vp-c-divider);
}

.feedback-question {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.feedback-actions {
  display: flex;
  gap: 8px;
}

.feedback-button {
  padding: 4px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 14px;
  color: var(--vp-c-text-1);
  text-decoration: none;
}
.feedback-button:hover,
.feedback-button[aria-pressed='true'] {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.feedback-button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.feedback-thanks {
  margin: 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
</style>
