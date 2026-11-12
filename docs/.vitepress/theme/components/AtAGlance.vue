<template>
  <section v-if="rows.length > 0" class="glance" aria-label="At a glance">
    <p class="glance-title">At a glance</p>
    <dl>
      <div v-for="row in rows" :key="row.label" class="glance-row">
        <dt>{{ row.label }}</dt>
        <dd>
          <span
            v-if="row.label === 'Status'"
            :class="['glance-status', `is-${row.value}`]"
          >
            {{ row.value }}
          </span>
          <template v-else>{{ row.value }}</template>
        </dd>
      </div>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'

const FIELDS: { key: string; label: string }[] = [
  { key: 'audience', label: 'Audience' },
  { key: 'type', label: 'Type' },
  { key: 'time', label: 'Time' },
  { key: 'prerequisites', label: 'Before you start' },
  { key: 'status', label: 'Status' },
]

const { frontmatter } = useData()

const rows = computed(() =>
  FIELDS.flatMap(({ key, label }) => {
    const value = frontmatter.value[key]
    return typeof value === 'string' && value !== '' ? [{ label, value }] : []
  }),
)
</script>

<style scoped>
.glance {
  margin-bottom: 24px;
  padding: 12px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  line-height: 1.5;
}

.glance-title {
  margin: 0 0 6px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.glance dl {
  margin: 0;
}

.glance-row + .glance-row {
  margin-top: 6px;
}

.glance dt {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}

.glance dd {
  margin: 0;
  color: var(--vp-c-text-1);
}

.glance-status {
  display: inline-block;
  padding: 0 8px;
  border-radius: 999px;
  font-weight: 600;
  background: var(--vp-c-default-soft);
}
.glance-status.is-current,
.glance-status.is-accepted {
  background: var(--vp-c-tip-soft);
  color: var(--vp-c-tip-1);
}
.glance-status.is-partial,
.glance-status.is-legacy {
  background: var(--vp-c-warning-soft);
  color: var(--vp-c-warning-1);
}
.glance-status.is-proposed {
  background: var(--vp-c-indigo-soft);
  color: var(--vp-c-indigo-1);
}
</style>
