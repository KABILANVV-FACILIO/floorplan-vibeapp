import { dataSource } from '../lib/dataSource';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { isOrgZoneUnit, roomOutlineChanges, saveFloorplanMarkers, saveFloorplanZones } from '../lib/facilioApiDataSource';
import { ROOM_OUTLINE_WRITES } from '../lib/featureFlags';
import type { Unit } from '../lib/types';

/** What an explicit save could not get into the org although the save as a whole went through. */
export interface PersistOutcome {
  /** Labels of rooms whose outline (a create, update or delete) did not reach the org. */
  roomsNotWritten: string[];
  /**
   * Ids of rooms whose outline write was tried and FAILED. The caller keeps these out of the new
   * saved snapshot (MARK_SAVED's `retry`), so they stay unsaved and the next Save sends them again
   * — a delete in particular is decided from that snapshot, and would otherwise never be retried.
   */
  roomsToRetry: string[];
}

/**
 * Explicit-save chokepoint ONLY — local per-action edits (place/update/delete/close-draft) call
 * `dataSource.saveUnits` directly and stop there; this additionally pushes real
 * `floorplanmarker`/`floorplanmarkedzone`/`indoorfloorplan` sync, and is deliberately reserved for "Save changes" /
 * mode-switch confirm / discard / reset, not every micro-edit. Syncing markers on every drag or
 * click was real, measured overhead (re-fetching indoorfloorplan geometry + the full marker list
 * per configured plan type, on every single edit) with no benefit — the real backend only needs
 * to reflect the floor once the user is done editing, same mental model as the "unsaved changes"
 * bar itself.
 *
 * The org write is AWAITED, and a write that persisted nothing throws. "Save changes" is the one
 * moment the user is explicitly waiting on the backend — the button shows a loader for exactly
 * that — so it must not report "Changes saved" while the write is still in flight, or after it
 * silently skipped every plan for lack of a georeference. The local (browser) copy is written
 * first regardless, so a failed org write never loses the edit; it just isn't called a save.
 *
 * `baseline` is the snapshot the user last had as saved (`state.savedUnits`), captured in the same
 * render as `units`. It is what lets the zone sync write only what the user changed, and tell a
 * room the user REMOVED from one that was simply never drawn (see saveFloorplanZones); without it
 * no outline is deleted. Discard passes the saved snapshot as both, so it writes no outline at all.
 * A save that went through but left some room outlines behind resolves with their labels, so the
 * caller can say so instead of a plain "Changes saved".
 *
 * Room outlines are written only once the markers went through (or there were none to write): a
 * save reported as failed must not have changed the org's outlines behind the user's back — they
 * would then be out of step with what a Discard puts back on screen.
 *
 * With ROOM_OUTLINE_WRITES off (the default for now — see featureFlags.ts) the zone sync is not
 * called at all: the save is the markers exactly as before rooms were read, and no request goes to
 * `floorplanmarkedzone` or `space`. The rooms whose outline the user changed anyway are handed back
 * in `roomsNotWritten` — never in `roomsToRetry`, which would keep them unsaved and have every
 * later Save report them again — so the toast can say their changes did not reach Facilio.
 */
export async function persistUnits(floorId: string, units: Unit[], baseline?: Unit[]): Promise<PersistOutcome> {
  await dataSource.saveUnits(floorId, units);
  if (!isFacilioApiConfigured) return { roomsNotWritten: [], roomsToRetry: [] };
  const result = await saveFloorplanMarkers(floorId, units);
  const hasPointUnits = units.some((u) => u.geom.kind === 'point' && u.type !== 'amenity');
  if (hasPointUnits && result.plansSynced === 0 && result.skipped.length) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] Save changes wrote NO markers to the org — ${result.skipped.join('; ')}. Positions are kept in this browser only.`);
    throw new Error(`markers not written to the org: ${result.skipped.join('; ')}`);
  }
  // Room outline writes are off: nothing more goes to the org. Only say which room changes stayed
  // behind; a reload draws the org's outline for them again.
  if (!ROOM_OUTLINE_WRITES) return { roomsNotWritten: roomOutlineChanges(floorId, units, baseline), roomsToRetry: [] };
  // Room outlines next: real `floorplanmarkedzone` records for rooms that stand for an org space.
  // Run when the markers were skipped for want of any to write — a floor can have its rooms' plan
  // georeferenced and nothing else — and reported the same way, so a room that did not reach the
  // org is never called saved.
  const zones = await saveFloorplanZones(floorId, units, baseline);
  if (zones.skipped.length) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] Save changes skipped some room outlines — ${zones.skipped.join('; ')}.`);
  }
  // Thrown only when a PLAN could not be written and no plan was: per-room skips (an editor-drawn
  // outline, a room this floor never loaded) on a save that otherwise went through are reported
  // through `roomsNotWritten`, not called a failed save. A room the user REMOVED counts as much as
  // one still on the floor — deleting the last room is a write too.
  if ((units.some(isOrgZoneUnit) || zones.retryIds.length > 0) && zones.plansSynced === 0 && zones.plansSkipped > 0) {
    throw new Error(`room outlines not written to the org: ${zones.skipped.join('; ')}`);
  }
  return { roomsNotWritten: [...new Set(zones.roomsNotWritten)], roomsToRetry: [...new Set(zones.retryIds)] };
}

/**
 * The toast for a save that went through: plain "Changes saved", or — when some room outlines did
 * not reach the org (drawn in Facilio's editor, a failed write, a room this floor never loaded) —
 * which ones, so the user isn't told a room was saved that will be gone, or back, on reload.
 *
 * With room outline writes off (`writes` false, the flag's value by default) every listed room is
 * one the app did not even try to write, and the toast says that in so many words: the desks went
 * through, those room changes are not saved to Facilio.
 */
export function savedNotice(outcome: Pick<PersistOutcome, 'roomsNotWritten'>, writes: boolean = ROOM_OUTLINE_WRITES): string {
  const labels = outcome.roomsNotWritten;
  if (!labels.length) return 'Changes saved';
  const named = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` +${labels.length - 3} more` : '');
  if (!writes) return `Saved — ${labels.length} room change${labels.length === 1 ? '' : 's'} not saved to Facilio (room outlines are read-only for now): ${named}`;
  return `Saved — ${labels.length} room outline${labels.length === 1 ? '' : 's'} not written to the org: ${named}`;
}
