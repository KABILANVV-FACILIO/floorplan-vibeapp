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
 * Vibe hosts are per-region — `vibe.facilio.com` (US), `.co.uk`, `.ae`, `.com.au`, `.us` (Azure),
 * `.co.ae` (Azure AE), `vibe-sa.facilio.com` (Oracle) — and an app is served at
 * `<linkName>.<vibeHost>`, optionally `preview-`prefixed. So match the `vibe` LABEL, never a
 * specific TLD: pinning one region's domain silently disables the vibe tiers in every other
 * region, which is exactly how this app ended up serving its demo seed in Azure AE.
 */
const VIBE_HOST = /(^|\.)vibe(-[a-z0-9]+)?\.facilio\./;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/;

/**
 * True when the app should use the Vibe tiers (connector + vibe-db function).
 *
 * Deliberately fails OPEN: anything that isn't plainly local dev assumes the runtime is there and
 * lets CompositeDataSource fall through if it isn't. A wrong `true` costs one rejected request;
 * a wrong `false` silently replaces the org's real data with the demo seed, which is far worse
 * and much harder to notice. `VITE_IS_VIBE_APP` overrides in either direction.
 */
export const isVibeApp: boolean = (() => {
  const flag = import.meta.env.VITE_IS_VIBE_APP;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return VIBE_HOST.test(host) || !LOCAL_HOST.test(host);
})();

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
