<template>
  <DefaultTheme.Layout>
    <template #home-hero-after>
      <PersonaPaths />
    </template>
    <template #doc-before>
      <AtAGlance class="glance-inline" />
    </template>
    <template #aside-outline-before>
      <AtAGlance />
    </template>
    <template #doc-footer-before>
      <PageFeedback />
    </template>
  </DefaultTheme.Layout>
</template>

<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import AtAGlance from './components/AtAGlance.vue'
import PageFeedback from './components/PageFeedback.vue'
import PersonaPaths from './components/PersonaPaths.vue'
</script>

<style scoped>
/* The aside is hidden below 1280px, so the card moves above the content. */
.glance-inline {
  display: none;
}

@media (max-width: 1279px) {
  .glance-inline {
    display: block;
  }
}
</style>
