/// <reference types="svelte" />
/// <reference types="vite/client" />

// Vite adds an `any` index signature to ImportMetaEnv. This option removes it,
// so an undeclared VITE_* key is an error and not `any`.
interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_STRATOS_URL?: string
  readonly VITE_APPVIEW_URL?: string
  readonly VITE_WEBAPP_URL?: string
  readonly VITE_STRATOS_SERVICE_DID?: string
  readonly VITE_ATPROTO_HANDLE_RESOLVER?: string
  readonly VITE_FEEDGEN_DID?: string
  readonly VITE_FEEDGEN_FEED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
