import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Stratos',
  description: 'Private, boundary-scoped data for AT Protocol',
  srcExclude: [
    'architecture-diagram.md',
    'design/**',
    'guide/webapp.md',
    'indexer-architecture.md',
    'multi-domain-enrollment.md',
    'operator/appview-integration.md',
    'operator/clubhouse-public-alpha.md',
    'operator/examples/**',
  ],
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }]],
  themeConfig: {
    logo: { src: '/icon.svg', alt: 'Stratos' },
    siteTitle: 'Stratos',
    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      {
        text: 'Client',
        link: '/client/getting-started',
        activeMatch: '/client/',
      },
      {
        text: 'Operator',
        link: '/operator/overview',
        activeMatch: '/operator/',
      },
      {
        text: 'Architecture',
        link: '/architecture/diagrams',
        activeMatch: '/architecture/',
      },
      { text: 'Lexicons', link: '/lexicons/', activeMatch: '/lexicons/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'What Stratos Does', link: '/guide/what-is-stratos' },
            { text: 'Core Concepts', link: '/guide/concepts' },
            { text: 'Create a Private Post', link: '/guide/first-post' },
            { text: 'Glossary', link: '/guide/glossary' },
            { text: 'Error Codes', link: '/guide/errors' },
          ],
        },
      ],
      '/client/': [
        {
          text: 'Client integration',
          items: [
            { text: 'Getting Started', link: '/client/getting-started' },
            { text: 'Enrollment', link: '/client/enrollment' },
            { text: 'Create Records', link: '/client/creating-records' },
            { text: 'Read Records', link: '/client/reading-records' },
            { text: 'Boundaries and Spaces', link: '/client/boundaries' },
            { text: 'Attestation Verification', link: '/client/attestation' },
            { text: 'API Reference', link: '/client/api-reference' },
            { text: 'Troubleshooting', link: '/client/troubleshooting' },
          ],
        },
      ],
      '/operator/': [
        {
          text: 'Operator guide',
          items: [
            { text: 'Overview', link: '/operator/overview' },
            { text: 'Architecture', link: '/operator/architecture' },
            { text: 'Deployment', link: '/operator/deployment' },
            { text: 'Configuration', link: '/operator/configuration' },
            { text: 'Operations', link: '/operator/operations' },
            { text: 'Telemetry', link: '/operator/telemetry' },
            { text: 'Security', link: '/operator/security' },
            { text: 'Troubleshooting', link: '/operator/troubleshooting' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Architecture Overview', link: '/architecture/diagrams' },
            { text: 'Hydration', link: '/architecture/hydration' },
            {
              text: 'Enrollment Signing',
              link: '/architecture/enrollment-signing',
            },
            {
              text: 'Repo-host Discovery',
              link: '/architecture/repo-host-discovery',
            },
          ],
        },
      ],
      '/lexicons/': [
        {
          text: 'Lexicon reference',
          items: [{ text: 'All Lexicons', link: '/lexicons/' }],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/NorthskySocial/stratos' },
    ],
    search: { provider: 'local' },
  },
})
