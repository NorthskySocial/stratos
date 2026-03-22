/// <reference types="svelte" />

interface ImportMetaEnv {
  readonly VITE_STRATOS_URL?: string
  readonly VITE_APPVIEW_URL?: string
  readonly VITE_ATPROTO_HANDLE_RESOLVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
