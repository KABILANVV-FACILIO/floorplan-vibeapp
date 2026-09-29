import { dataSource } from '../lib/dataSource';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { isOrgZoneUnit, saveFloorplanMarkers, saveFloorplanZones } from '../lib/facilioApiDataSource';
import type { Unit } from '../lib/types';

/** What an explicit save could not get into the org although the save as a whole went through. */
export interface PersistOutcome {
  /** Labels of rooms whose outline (a create, update or delete) did not reach the org. */
  roomsNotWritten: string[];
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
 * render as `units`. It is what lets the zone sync tell a room the user REMOVED from one that was
 * simply never drawn (see saveFloorplanZones); without it no outline is deleted — the discard and
 * demo-reset housekeeping pass none. A save that went through but left some room outlines behind
 * resolves with their labels, so the caller can say so instead of a plain "Changes saved".
 */
export async function persistUnits(floorId: string, units: Unit[], baseline?: Unit[]): Promise<PersistOutcome> {
  await dataSource.saveUnits(floorId, units);
  if (!isFacilioApiConfigured) return { roomsNotWritten: [] };
  const result = await saveFloorplanMarkers(floorId, units);
  // Room outlines next: real `floorplanmarkedzone` records for rooms that stand for an org space.
  // Run even when the markers were skipped — a floor can have its rooms' plan georeferenced and
  // nothing else — and reported the same way, so a room that did not reach the org is never
  // called saved.
  const zones = await saveFloorplanZones(floorId, units, baseline);
  const hasPointUnits = units.some((u) => u.geom.kind === 'point' && u.type !== 'amenity');
  if (hasPointUnits && result.plansSynced === 0 && result.skipped.length) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] Save changes wrote NO markers to the org — ${result.skipped.join('; ')}. Positions are kept in this browser only.`);
    throw new Error(`markers not written to the org: ${result.skipped.join('; ')}`);
  }
  if (zones.skipped.length) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] Save changes skipped some room outlines — ${zones.skipped.join('; ')}.`);
  }
  // Thrown only when a PLAN could not be written and no plan was: per-room skips (an editor-drawn
  // outline, a room this floor never loaded) on a save that otherwise went through are reported
  // through `roomsNotWritten`, not called a failed save.
  if (units.some(isOrgZoneUnit) && zones.plansSynced === 0 && zones.plansSkipped > 0) {
    throw new Error(`room outlines not written to the org: ${zones.skipped.join('; ')}`);
  }
  return { roomsNotWritten: [...new Set(zones.roomsNotWritten)] };
}

/**
 * The toast for a save that went through: plain "Changes saved", or — when some room outlines did
 * not reach the org (drawn in Facilio's editor, a failed write, a room this floor never loaded) —
 * which ones, so the user isn't told a room was saved that will be gone, or back, on reload.
 */
export function savedNotice(outcome: PersistOutcome): string {
  const labels = outcome.roomsNotWritten;
  if (!labels.length) return 'Changes saved';
  const named = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` +${labels.length - 3} more` : '');
  return `Saved — ${labels.length} room outline${labels.length === 1 ? '' : 's'} not written to the org: ${named}`;
}
