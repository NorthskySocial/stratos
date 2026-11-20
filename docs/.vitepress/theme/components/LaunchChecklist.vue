<template>
  <section class="checklist" aria-labelledby="checklist-title">
    <div class="checklist-head">
      <p id="checklist-title" class="checklist-title">Launch checklist</p>
      <p class="checklist-count" aria-live="polite">
        {{ doneCount }} of {{ STEPS.length }} done
      </p>
    </div>
    <div
      class="checklist-bar"
      role="progressbar"
      :aria-valuenow="doneCount"
      aria-valuemin="0"
      :aria-valuemax="STEPS.length"
      aria-labelledby="checklist-title"
    >
      <span :style="{ width: `${(doneCount / STEPS.length) * 100}%` }" />
    </div>
    <ol class="checklist-steps">
      <li v-for="(step, i) in STEPS" :key="step.text">
        <input
          :id="`launch-step-${i}`"
          type="checkbox"
          :checked="done[i] === true"
          @change="toggle(i, ($event.target as HTMLInputElement).checked)"
        />
        <label :for="`launch-step-${i}`">{{ step.text }}</label>
        <a :href="withBase(step.link)">{{ step.page }}</a>
      </li>
    </ol>
    <p class="checklist-note">Your ticks stay in this browser only.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

const STORAGE_KEY = 'stratos-docs-launch-checklist'

const STEPS = [
  {
    text: 'Choose the service DID',
    page: 'Deployment',
    link: '/operator/deployment#step-2-choose-the-service-did',
  },
  {
    text: 'Set the environment, including the first admin',
    page: 'Configuration',
    link: '/operator/configuration#admin-authorization',
  },
  {
    text: 'Check the OAuth client metadata',
    page: 'Deployment',
    link: '/operator/deployment#step-4-check-the-oauth-client-metadata',
  },
  {
    text: 'Start the service and verify it',
    page: 'Deployment',
    link: '/operator/deployment#step-6-verify-the-deployment',
  },
  {
    text: 'Create boundaries',
    page: 'Manage boundaries',
    link: '/operator/boundaries',
  },
  {
    text: 'Run the feed generator with encrypted-volume',
    page: 'Run the feed generator',
    link: '/operator/feedgen-ng#storage-profiles',
  },
  {
    text: 'Make one authenticated feed request',
    page: 'Run the feed generator',
    link: '/operator/feedgen-ng#run-it',
  },
  {
    text: 'Set up backups and monitoring',
    page: 'Operations',
    link: '/operator/operations#backup',
  },
]

const done = ref<Record<number, boolean>>({})
const doneCount = computed(
  () => STEPS.filter((_, i) => done.value[i] === true).length,
)

// Progress is read after mount so the server render and first client render
// match. Storage can be blocked, so every access is guarded.
onMounted(() => {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved) done.value = JSON.parse(saved) as Record<number, boolean>
  } catch {
    done.value = {}
  }
})

function toggle(index: number, checked: boolean) {
  done.value = { ...done.value, [index]: checked }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(done.value))
  } catch {
    // Progress still shows for this visit when storage is unavailable.
  }
}
</script>

<style scoped>
.checklist {
  margin: 1.5rem 0;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.checklist-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.checklist-title {
  margin: 0;
  font-weight: 700;
}

.checklist-count {
  margin: 0;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}

.checklist-bar {
  height: 6px;
  margin: 8px 0 12px;
  border-radius: 999px;
  background: var(--vp-c-default-soft);
  overflow: hidden;
}
.checklist-bar span {
  display: block;
  height: 100%;
  background: var(--vp-c-brand-1);
  transition: width 200ms ease-out;
}

.checklist-steps {
  margin: 0;
  padding-left: 1.5rem;
}

.checklist-steps li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  margin: 6px 0;
}

.checklist-steps input {
  flex: none;
  accent-color: var(--vp-c-brand-1);
}

.checklist-steps input:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.checklist-steps label {
  flex: 1 1 12rem;
}

.checklist-steps a {
  font-size: 0.85rem;
}

.checklist-note {
  margin: 8px 0 0;
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
}

@media (prefers-reduced-motion: reduce) {
  .checklist-bar span {
    transition: none;
  }
}
</style>
