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
 * OFF until that write path has had more testing. The org holds 353 zones written by the
 * floorplan onboarding (geoId `space-<id>`) plus a few drawn in Facilio's own editor, and a wrong
 * create/update/delete there is visible in Facilio itself, not just in this app. The READ path
 * does not depend on this: a floor load still draws the org's outlines as placed rooms and takes
 * them out of "Available to place".
 *
 * With it off, desks, lockers and parking stalls save exactly as before rooms were read, and no
 * request of any kind goes to `floorplanmarkedzone` or `space` from a save, a Discard or a Refresh.
 * A save that carries room outline changes (traced, reshaped, relabelled, moved plan, deleted,
 * rebound to another record) still succeeds for the markers, and its toast names the rooms whose
 * changes did not reach Facilio; after a reload the org's outline shows again.
 *
 * To enable: set this to `true` and deploy. Nothing else changes — the write path, its tests
 * (markedZones.test.ts / persistUnits.test.ts force it on through `vi.mock`) and the retry /
 * "not written" reporting are all already in place.
 */
export const ROOM_OUTLINE_WRITES: boolean = false;
