/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_TLDRAW_LICENSE_KEY?: string
}

declare const __BUILD_COMMIT__: string
declare const __BUILD_DATE__: string
