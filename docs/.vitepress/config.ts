import { defineConfig } from 'vitepress'

const base = '/'

export default defineConfig({
  title: 'Stratos',
  description: 'Private permissioned data layer for ATProtocol',
  base,

  srcExclude: [
    'hydration-architecture.md',
    'enrollment-signing.md',
    'multi-domain-enrollment.md',
    'architecture-diagram.md',
    'client-guide.md',
    'operator-guide.md',
    'animations/**',
  ],

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }]],

  themeConfig: {
    logo: { src: '/icon.svg', alt: 'Stratos' },
    siteTitle: 'Stratos',

    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      {
        text: 'Client Integration',
        link: '/client/getting-started',
        activeMatch: '/client/',
      },
      {
        text: 'Operator Guide',
        link: '/operator/overview',
        activeMatch: '/operator/',
      },
      {
        text: 'Architecture',
        link: '/architecture/hydration',
        activeMatch: '/architecture/',
      },
      { text: 'Lexicons', link: '/lexicons/', activeMatch: '/lexicons/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            {
              text: 'What Is Shared Private Data?',
              link: '/guide/what-is-stratos',
            },
            { text: 'Core Concepts', link: '/guide/concepts' },
          ],
        },
      ],
      '/client/': [
        {
          text: 'Client Integration',
          items: [
            { text: 'Getting Started', link: '/client/getting-started' },
            { text: 'User Enrollment', link: '/client/enrollment' },
            { text: 'Creating Records', link: '/client/creating-records' },
            { text: 'Reading Records', link: '/client/reading-records' },
            { text: 'Domain Boundaries', link: '/client/boundaries' },
            {
              text: 'Repo Export & Import',
              link: '/client/repo-export-import',
            },
            { text: 'UI Patterns', link: '/client/ui-patterns' },
            { text: 'Attestation Verification', link: '/client/attestation' },
            { text: 'API Reference', link: '/client/api-reference' },
            { text: 'Best Practices', link: '/client/best-practices' },
            { text: 'Troubleshooting', link: '/client/troubleshooting' },
          ],
        },
      ],
      '/operator/': [
        {
          text: 'Operator Guide',
          items: [
            { text: 'Overview', link: '/operator/overview' },
            { text: 'Architecture', link: '/operator/architecture' },
            { text: 'Deployment', link: '/operator/deployment' },
            { text: 'Configuration', link: '/operator/configuration' },
            {
              text: 'AppView Integration',
              link: '/operator/appview-integration',
            },
            { text: 'Operations', link: '/operator/operations' },
            { text: 'Security', link: '/operator/security' },
            { text: 'Troubleshooting', link: '/operator/troubleshooting' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Hydration Architecture', link: '/architecture/hydration' },
            {
              text: 'Enrollment Signing',
              link: '/architecture/enrollment-signing',
            },
            {
              text: 'Multi-Domain Enrollment',
              link: '/architecture/multi-domain-enrollment',
            },
            { text: 'System Diagrams', link: '/architecture/diagrams' },
          ],
        },
      ],
      '/lexicons/': [
        {
          text: 'Lexicon Reference',
          items: [{ text: 'All Lexicons', link: '/lexicons/' }],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/NorthskySocial/stratos' },
    ],

    footer: {
      message:
        'Built on ATProtocol, designed by <a href="https://northskysocial.com" target="_blank">Northsky Social</a>',
      copyright: `<center><img src="${base}northsky.png" alt="Northsky Social" width="48" height="48" /></center>`,
    },

    search: {
      provider: 'local',
    },
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'one-dark-pro',
    },
  },
})
