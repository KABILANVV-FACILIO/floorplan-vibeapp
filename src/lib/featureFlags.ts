/**
 * Build-time switches for paths that are written but not yet trusted against a live org.
 *
 * Constants, not settings: flipping one is a code change that goes through review and a deploy,
 * never something a user (or a stray localStorage key) can turn on in production.
 */

/**
 * Whether "Save changes" writes ROOM OUTLINES back to the org as `floorplanmarkedzone` records
 * (`persistUnits` -> `saveFloorplanZones`: create / update / delete zones, and the `space` reads
 * that decide whether a room may get one).
 *
 * ON since 2026-10-01 (requested). What a save does with it on — only for rooms the user CHANGED
 * since the last save (see saveFloorplanZones):
 *  - a room traced for a space with no outline yet -> a zone is CREATED for it (geoId `space-<id>`);
 *  - a room reshaped, relabelled or moved -> its app zone(s) are UPDATED;
 *  - a room REMOVED from the plan -> its app zones are DELETED. Only zones in the app's own
 *    naming (`space-<id>`, the onboarding's included) are ever written; a zone drawn in
 *    Facilio's own editor is never modified or deleted, and is reported in the toast instead.
 * A write the org refuses keeps the room unsaved and is retried on the next Save. The READ path
 * never depended on this flag.
 *
 * Switching it off again restores the old behaviour: desks, lockers and parking stalls save as
 * before, no request goes to `floorplanmarkedzone` or `space` from a save, a Discard or a Refresh,
 * and the toast names the room changes that did not reach Facilio.
 */
export const ROOM_OUTLINE_WRITES: boolean = true;

/**
 * Whether the `floorplanApi` function is deployed. It is not, and as written it cannot be: its
 * `connect()` runs DDL, and the app's database login may never CREATE (tables come only from
 * `facilio vibe db import`). Until its DDL is removed and its tables imported, every call to it
 * fails — and three of them used to fire on every page open (the stored-floorplan list, the settings
 * read and the department colours), each a round trip for nothing. Off, nothing is sent: every
 * caller already reads "unavailable" as "use the next tier" (the file store, the browser).
 */
export const FLOORPLAN_API_DEPLOYED: boolean = false;

/**
 * Whether the demo seed (src/data/*.json — sample sites, people, desks and bookings) may be shown.
 * Only under the dev server (`npm run dev`, and vitest): every `vite build` — whatever is deployed
 * to preview or production — has it off, so a live user never sees a made-up person or floor,
 * even when the org's own list comes back empty or fails.
 */
export const DEMO_DATA: boolean = import.meta.env.DEV;
