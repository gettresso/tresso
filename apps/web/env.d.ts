/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_OAUTH_CLIENT_ID: string
  readonly VITE_DESKTOP_OAUTH_CLIENT_ID: string
  readonly VITE_NATIVE_REDIRECT_URI: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Set by public/config.js, which the web image renders when it starts. */
interface Window {
  tressoConfig?: { apiUrl?: string }
}

/** The push worker: a plain script in public/, which its tests load in a fake service worker scope. */
declare module '*/public/push-worker.js'
