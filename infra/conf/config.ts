import type { StratosConfig } from '../src/config.ts'

const config: StratosConfig = {
  // --- Environment ---
  environment: 'staging',

  // --- DNS ---
  domainName: 'atverkackt.de',
  // hostedZoneId: 'Z1234567890',  // optional — looked up by domainName if omitted
  stratosSubdomain: 'stratos', // → stratos.example.com
  webappSubdomain: 'app', // → app.example.com
  storageBackend: 'postgres',

  // --- Stratos service ---
  stratos: {
    serviceDid: 'did:web:stratos.atverkackt.de',
    publicUrl: 'https://stratos.atverkackt.de',
    allowedDomains: 'atverkackt.de',

    // serviceFragment: 'atproto_pns',
    // retentionDays: '30',
    enrollmentmode: ENROLLMENT_MODE.OPEN,
    // allowedDids: '',
    // allowedPdsEndpoints: '',
    // plcUrl: 'https://plc.directory',
    // signingKeyHex: '',
    // blobStorage: 'local',

    // OAuth
    // oauthClientId: '',
    // oauthClientSecret: '',
    // oauthClientName: '',
    // oauthLogoUri: '',
    // oauthTosUri: '',
    // oauthPolicyUri: '',

    // Metadata
    // repoUrl: 'https://github.com/NorthskySocial/stratos',
    // operatorContact: '',
    // logLevel: 'info',
    // devMode: 'false',
  },

  // --- Webapp ---
  webapp: {
    stratosUrl: 'https://stratos.atverkackt.de',
  },

  // --- ECS task sizing ---
  // stratosTaskCpu: 512,
  // stratosTaskMemory: 1024,
  // webappTaskCpu: 256,
  // webappTaskMemory: 512,

  // --- Scaling ---
  // stratosDesiredCount: 1,
  // webappDesiredCount: 1,
}

export default config
