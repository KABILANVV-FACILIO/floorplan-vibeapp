/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_MODE?: string;
  readonly VITE_IS_CONNECTED_APP?: string;
  readonly VITE_FACILIO_API_BASE_URL?: string;
  readonly VITE_FACILIO_TOKEN?: string;
  /** Force the vibe tiers on in dev; a deployed app detects itself from its host. */
  readonly VITE_IS_VIBE_APP?: string;
  /** Point the vibe SDK at a deployed app's server during dev. Unset in a real deploy. */
  readonly VITE_VIBE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
