<template>
  <section class="personas" aria-labelledby="personas-title">
    <h2 id="personas-title" class="personas-title">Choose your path</h2>
    <div class="persona-grid">
      <article v-for="persona in PERSONAS" :key="persona.title" class="persona">
        <h3 class="persona-name">{{ persona.title }}</h3>
        <p class="persona-goal">{{ persona.goal }}</p>
        <ol class="persona-path">
          <li v-for="step in persona.steps" :key="step.link">
            <a :href="withBase(step.link)">{{ step.title }}</a>
            <span>{{ step.note }}</span>
          </li>
        </ol>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { withBase } from 'vitepress'

const PERSONAS = [
  {
    title: 'I build an app',
    goal: 'Add private posts to an AT Protocol client.',
    steps: [
      {
        title: 'What is Stratos?',
        note: 'The idea in plain words',
        link: '/guide/what-is-stratos',
      },
      {
        title: 'Your first post',
        note: 'A short tutorial',
        link: '/guide/first-post',
      },
      {
        title: 'Custody and routing',
        note: 'Where each write goes',
        link: '/client/custody',
      },
      { title: 'API methods', note: 'Reference', link: '/reference/api' },
    ],
  },
  {
    title: 'I run a community',
    goal: 'Host a Stratos service for your members.',
    steps: [
      {
        title: 'Operator overview',
        note: 'What you run and why',
        link: '/operator/overview',
      },
      {
        title: 'Deployment',
        note: 'Service DID to health check',
        link: '/operator/deployment',
      },
      {
        title: 'Run the feed generator',
        note: 'Feeds for members',
        link: '/operator/feedgen-ng',
      },
      {
        title: 'Manage boundaries',
        note: 'Members and rooms',
        link: '/operator/boundaries',
      },
    ],
  },
  {
    title: "I'm a member",
    goal: 'Join a community and post privately.',
    steps: [
      {
        title: 'What is Stratos?',
        note: 'The idea in plain words',
        link: '/guide/what-is-stratos',
      },
      {
        title: 'Demo web app',
        note: 'Enroll and post',
        link: '/guide/webapp',
      },
      {
        title: 'Core concepts',
        note: 'Boundaries and custody',
        link: '/guide/concepts',
      },
      {
        title: 'Glossary',
        note: 'Terms you will meet',
        link: '/reference/glossary',
      },
    ],
  },
  {
    title: 'I implement the protocol',
    goal: 'Interoperate with spaces and sync.',
    steps: [
      {
        title: 'Permissioned spaces',
        note: 'How Stratos maps to spaces',
        link: '/architecture/permissioned-spaces',
      },
      {
        title: 'Spaces: current contract',
        note: 'What ships today',
        link: '/architecture/spaces-alignment',
      },
      {
        title: 'Feed generator design',
        note: 'Sync and verification',
        link: '/architecture/feed-generator',
      },
      {
        title: 'Lexicons',
        note: 'Every zone.stratos method',
        link: '/lexicons/',
      },
    ],
  },
]
</script>

<style scoped>
.personas {
  margin: 0 auto;
  padding: 0 24px 48px;
  max-width: 1152px;
}

.personas-title {
  margin: 0 0 16px;
  font-size: 24px;
  font-weight: 700;
}

.persona-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.persona {
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.persona-name {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.persona-goal {
  margin: 4px 0 12px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.persona-path {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 14px;
}

.persona-path li {
  margin: 6px 0;
}

.persona-path a {
  display: block;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.persona-path a:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.persona-path span {
  display: block;
  color: var(--vp-c-text-2);
}
</style>
