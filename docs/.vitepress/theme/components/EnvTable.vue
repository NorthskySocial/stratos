<template>
  <div class="env-table">
    <div class="env-controls" role="search">
      <label class="env-field">
        <span>Search</span>
        <input
          v-model="query"
          type="search"
          placeholder="Name or description"
          autocomplete="off"
        />
      </label>
      <label class="env-field">
        <span>Category</span>
        <select v-model="category">
          <option value="">All</option>
          <option v-for="name in categories" :key="name" :value="name">
            {{ name }}
          </option>
        </select>
      </label>
      <label class="env-check">
        <input v-model="requiredOnly" type="checkbox" />
        <span>Required only</span>
      </label>
    </div>
    <p class="env-count" aria-live="polite">
      {{ shown.length }} of {{ variables.length }} shown
    </p>
    <table>
      <thead>
        <tr>
          <th scope="col">Variable</th>
          <th scope="col">Default</th>
          <th scope="col">Description</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="variable in shown"
          :id="anchorFor(variable.name)"
          :key="variable.name"
        >
          <td>
            <a class="env-name" :href="`#${anchorFor(variable.name)}`">
              <code>{{ variable.name }}</code>
            </a>
            <span v-if="variable.required" class="env-required">
              {{ requiredLabel(variable.required) }}
            </span>
            <span class="env-category">{{ variable.category }}</span>
          </td>
          <td>
            <code v-if="variable.default">{{ variable.default }}</code>
            <span v-else aria-label="No default">—</span>
          </td>
          <td>
            <template
              v-for="(part, i) in codeSpans(variable.description)"
              :key="i"
            >
              <code v-if="part.code">{{ part.text }}</code>
              <span v-else>{{ part.text }}</span>
            </template>
          </td>
        </tr>
        <tr v-if="shown.length === 0">
          <td colspan="3">
            No variable matches. Clear the search or pick another category.
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import variables from '../../../reference/env.data.json'

interface EnvVariable {
  name: string
  category: string
  required: boolean | string
  default: string
  description: string
}

const typedVariables = variables as EnvVariable[]
const query = ref('')
const category = ref('')
const requiredOnly = ref(false)

const categories = [...new Set(typedVariables.map((v) => v.category))]

const shown = computed(() => {
  const term = query.value.trim().toLowerCase()
  return typedVariables.filter((v) => {
    if (category.value && v.category !== category.value) return false
    if (requiredOnly.value && !v.required) return false
    if (!term) return true
    return `${v.name} ${v.description}`.toLowerCase().includes(term)
  })
})

function anchorFor(name: string): string {
  return name.toLowerCase()
}

function requiredLabel(required: boolean | string): string {
  return typeof required === 'string'
    ? `required ${required.toLowerCase()}`
    : 'required'
}

function codeSpans(text: string): { text: string; code: boolean }[] {
  return text
    .split('`')
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((part) => part.text !== '')
}
</script>

<style scoped>
.env-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 16px;
  margin: 1rem 0 0.5rem;
}

.env-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.env-field input,
.env-field select {
  min-width: 14rem;
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.9rem;
}

.env-check {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  font-size: 0.9rem;
}

.env-field input:focus-visible,
.env-field select:focus-visible,
.env-check input:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

.env-count {
  margin: 0;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}

.env-name {
  text-decoration: none;
}

.env-required {
  margin-left: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--vp-c-warning-1);
  white-space: nowrap;
}

.env-category {
  display: block;
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
}

tr:target {
  background: var(--vp-c-brand-soft);
}

@media (max-width: 640px) {
  .env-field input,
  .env-field select {
    min-width: 0;
    width: 100%;
  }
  .env-field {
    flex: 1 1 100%;
  }
}
</style>
