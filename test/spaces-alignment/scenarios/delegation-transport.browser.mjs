import { createBrowserAuth } from '../../../stratos-browser/src/auth.js'

const domain = window.delegationScenarioDomain
if (!domain) throw new Error('Sandbox domain missing')

const origin = window.location.origin
window.delegationScenarioAuth = createBrowserAuth({
  appName: 'Clubhouse',
  scopes: [
    'atproto',
    'repo:zone.stratos.actor.enrollment',
    'repo:zone.stratos.feed.post',
    'rpc:zone.stratos.feedgen.getFeed?aud=*',
  ],
  spaceWriteScope: {
    serviceDid: `did:web:stratos-e2e.${domain}`,
    actions: ['read', 'create', 'update', 'delete'],
  },
  handleResolver: `https://spaces-pds-e2e.${domain}`,
  plcDirectoryUrl: `https://plc.${domain}`,
  getBaseUrl: () => origin,
  getClientId: () => `${origin}/client-metadata.json`,
  getRedirectUri: () => `${origin}/`,
  isLoopback: () => false,
})
