import { defineConfig } from 'vitepress'

const base = '/'

// Sidebar text is rendered as HTML, not Vue, so the Badge component cannot be
// used there. These classes match the default theme's Badge output.
function badge(label: string, type: 'info' | 'tip' | 'warning' | 'danger') {
  return `<span class="VPBadge ${type}">${label}</span>`
}

const referenceSidebar = [
  {
    text: 'Reference',
    items: [
      { text: 'API methods', link: '/reference/api' },
      { text: 'Lexicons', link: '/lexicons/' },
      { text: 'Error codes', link: '/reference/errors' },
      { text: 'Environment variables', link: '/reference/env' },
      { text: 'Glossary', link: '/reference/glossary' },
    ],
  },
]

export default defineConfig({
  title: 'Stratos',
  description: 'Private permissioned data layer for ATprotocol',
  base,
  lastUpdated: true,
  // Contributor and design notes stay in the repository but not on the site.
  srcExclude: ['design/**', 'SCREENSHOTS.md'],

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }]],

  themeConfig: {
    logo: { src: '/icon.svg', alt: 'Stratos' },
    siteTitle: 'Stratos',

    nav: [
      { text: 'Learn', link: '/guide/what-is-stratos', activeMatch: '/guide/' },
      {
        text: 'Build',
        link: '/client/getting-started',
        activeMatch: '/client/',
      },
      {
        text: 'Operate',
        link: '/operator/overview',
        activeMatch: '/operator/',
      },
      {
        text: 'How it works',
        link: '/architecture/diagrams',
        activeMatch: '/architecture/',
      },
      {
        text: 'Reference',
        link: '/reference/api',
        activeMatch: '/(reference|lexicons)/',
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Learn',
          items: [
            {
              text: 'What is Stratos? (explained simply)',
              link: '/guide/what-is-stratos',
            },
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Core concepts', link: '/guide/concepts' },
            { text: 'Tutorial: your first post', link: '/guide/first-post' },
            { text: 'Demo web app', link: '/guide/webapp' },
          ],
        },
      ],
      '/client/': [
        {
          text: 'Start',
          items: [
            { text: 'Getting started', link: '/client/getting-started' },
            { text: 'Custody and routing', link: '/client/custody' },
          ],
        },
        {
          text: 'Write and read',
          items: [
            { text: 'User enrollment', link: '/client/enrollment' },
            { text: 'Creating records', link: '/client/creating-records' },
            { text: 'Reading records', link: '/client/reading-records' },
            { text: 'Private feed attachments', link: '/client/feedgen-blobs' },
            { text: 'Boundaries', link: '/client/boundaries' },
          ],
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Attestation verification', link: '/client/attestation' },
            {
              text: 'Repo export and import',
              link: '/client/repo-export-import',
            },
          ],
        },
        {
          text: 'Help',
          items: [
            { text: 'UI patterns', link: '/client/ui-patterns' },
            { text: 'Best practices', link: '/client/best-practices' },
            { text: 'Troubleshoot your app', link: '/client/troubleshooting' },
          ],
        },
      ],
      '/operator/': [
        {
          text: 'Plan',
          items: [
            { text: 'Overview', link: '/operator/overview' },
            { text: 'System architecture', link: '/operator/architecture' },
            { text: 'Security', link: '/operator/security' },
          ],
        },
        {
          text: 'Deploy',
          items: [
            { text: 'Deployment', link: '/operator/deployment' },
            { text: 'Deployment examples', link: '/operator/examples/' },
            { text: 'Configuration', link: '/operator/configuration' },
            { text: 'Run the feed generator', link: '/operator/feedgen-ng' },
          ],
        },
        {
          text: 'Run',
          items: [
            { text: 'Operations', link: '/operator/operations' },
            { text: 'Manage boundaries', link: '/operator/boundaries' },
            { text: 'Boundary history', link: '/operator/boundary-history' },
            {
              text: 'Troubleshoot the service',
              link: '/operator/troubleshooting',
            },
          ],
        },
        {
          text: 'Upgrades',
          items: [
            {
              text: 'October spaces rollout',
              link: '/operator/upgrades/october-spaces',
            },
          ],
        },
        {
          text: 'Legacy',
          collapsed: true,
          items: [
            {
              text: `AppView integration ${badge('legacy', 'warning')}`,
              link: '/operator/appview-integration',
            },
            {
              text: `Feedgen boundary catalogue ${badge('legacy', 'warning')}`,
              link: '/operator/feedgen-boundary-catalog',
            },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Explainers',
          items: [
            { text: 'System at a glance', link: '/architecture/diagrams' },
            {
              text: 'Permissioned spaces',
              link: '/architecture/permissioned-spaces',
            },
            {
              text: 'Feed generator design',
              link: '/architecture/feed-generator',
            },
            { text: 'Hydration', link: '/architecture/hydration' },
            {
              text: 'Enrollment signing',
              link: '/architecture/enrollment-signing',
            },
            {
              text: 'Multi-domain enrollment',
              link: '/architecture/multi-domain-enrollment',
            },
            {
              text: 'Repo-host discovery',
              link: '/architecture/repo-host-discovery',
            },
          ],
        },
        {
          text: 'Decisions',
          items: [
            {
              text: `Spaces: current contract ${badge('partial', 'warning')}`,
              link: '/architecture/spaces-alignment',
            },
            {
              text: `Credential revocation contract ${badge('accepted', 'tip')}`,
              link: '/architecture/credential-revocation-contract',
            },
            {
              text: `October writer sync contract ${badge('proposed', 'info')}`,
              link: '/architecture/october-writer-sync-contract',
            },
            {
              text: 'Service key history',
              link: '/architecture/service-key-history',
            },
          ],
        },
        {
          text: 'Legacy',
          collapsed: true,
          items: [
            {
              text: `AppView indexer ${badge('legacy', 'warning')}`,
              link: '/architecture/appview-indexer',
            },
          ],
        },
      ],
      '/reference/': referenceSidebar,
      '/lexicons/': referenceSidebar,
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/NorthskySocial/stratos' },
    ],

    footer: {
      message:
        'Built on ATprotocol, designed by <a href="https://northskysocial.com" target="_blank">Northsky Social</a> · <a href="https://github.com/NorthskySocial/stratos/tree/main/docs/design" target="_blank">Contributing docs</a>',
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
