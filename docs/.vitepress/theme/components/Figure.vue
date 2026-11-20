<template>
  <figure class="figure-card">
    <figcaption class="figure-label">
      <span v-if="step !== undefined" class="figure-step">{{ step }}</span>
      <span>{{ caption }}</span>
    </figcaption>
    <slot />
  </figure>
</template>

<script setup lang="ts">
defineProps<{
  caption: string
  step?: number | string
}>()
</script>

<style scoped>
.figure-card {
  margin: 2rem 0;
  border-radius: 14px;
  overflow: hidden;
  border: 1.5px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.figure-label {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1.1rem;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
}

.figure-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-size: 0.78rem;
  font-weight: 700;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  flex-shrink: 0;
}

.dark .figure-step {
  color: var(--vp-c-bg);
}

/* A diagram inside the card already has its own soft background. */
.figure-card :deep(.flow),
.figure-card :deep(.state) {
  margin: 0;
  border-radius: 0;
}
</style>
