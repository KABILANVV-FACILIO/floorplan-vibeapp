import { isFacilioApiConfigured } from './facilioApi';
import { isVibeApp } from './vibe';

/**
 * Whether this page can write to the org at all.
 *
 * Assignments, vacates, bookings and desk positions reach Facilio through the host bridge, which exists only
 * when the app is opened inside Facilio or the mobile app. The deployed app opened with no host has
 * nowhere to send them — and used to write them to this browser alone and report them done, so an
 * assignment showed as made and was gone on reload.
 *
 * Plain local dev (`npm run dev`, not a vibe host) is the other case with no Facilio API, and there
 * the browser copy IS the whole job, so it is not refused.
 */
export function orgWritesUnavailable(vibe: boolean = isVibeApp, api: boolean = isFacilioApiConfigured): boolean {
  return vibe && !api;
}

export const NO_HOST_ASSIGN_MESSAGE = 'Not changed — this page is not connected to Facilio. Open Floorplan Manager from inside Facilio to assign, vacate or book.';

/**
 * Refuse an org write this page cannot make, saying why. Returns true when it refused, so a caller
 * reads as `if (refuseOrgWrite(toast)) return;` — before any local change, so nothing is left in
 * this browser that the org never received.
 */
export function refuseOrgWrite(toast: (message: string, ms?: number) => void, unavailable: boolean = orgWritesUnavailable()): boolean {
  if (!unavailable) return false;
  toast(NO_HOST_ASSIGN_MESSAGE, 8000);
  return true;
}
