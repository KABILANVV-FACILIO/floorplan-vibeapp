import { createVibe } from '@facilio/vibe-sdk';
import type { Vibe } from '@facilio/vibe-sdk';

/**
 * Facilio Vibe app runtime — the primary target for this build.
 *
 * The SDK is transport-only and synchronous to construct: `createVibe()` resolves its server from
 * `window.location.origin` and the platform resolves WHICH app a request belongs to from the
 * request host (the `<linkName>.vibe.facilio.com` subdomain), so there is no appUuid to pass and
 * no readiness gate to await. Identity rides the session cookie.
 *
 * `VITE_VIBE_SERVER_URL` exists only for `npm run dev` against a deployed app's server; leave it
 * unset in a real deploy so the app talks to its own origin.
 */
const serverURL = import.meta.env.VITE_VIBE_SERVER_URL;

/**
 * True when the app should use the Vibe tiers (connector + vibe-db function).
 *
 * Auto-detected from the host so a deployed app needs no build flag, with an explicit
 * `VITE_IS_VIBE_APP` override for dev against a real vibe server.
 */
export const isVibeApp: boolean =
  import.meta.env.VITE_IS_VIBE_APP === 'true' ||
  (typeof window !== 'undefined' && /(^|\.)vibe\.facilio\.com$/.test(window.location.hostname));

export const vibe: Vibe = createVibe(serverURL ? { serverURL } : undefined);

/**
 * The app's Studio Function holding every app-owned record (placement geometry, assignments,
 * bookings, settings, floorplan files). The browser has no direct database access — the vibe DB
 * is a per-app Postgres schema reachable only through a function handler, so this name plus a
 * handler name is the entire data contract. See `functions/floorplanApi/code.ts`.
 */
export const FLOORPLAN_FN = 'floorplanApi';

/** The org's CMMS connection — the source for real portfolio/people/asset records. */
export const CMMS_CONNECTION = 'facilio-cmms';
