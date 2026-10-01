import type { Booking } from './types';
import { wallClockInTz } from './orgTime';
import { isPendingApprovalName, stateName } from './stateflowApi';

/**
 * A `spacebooking` row as the org's list endpoint returns it — only the fields this app reads.
 * The booked resource is whichever lookup the record set: `desk` for a desk booking, `space` for
 * a room, `parkingStall` for a stall.
 */
export interface SpaceBookingRow {
  id: number | string;
  desk?: { id?: number | string } | null;
  space?: { id?: number | string } | null;
  parkingStall?: { id?: number | string } | null;
  bookingStartTime?: number;
  bookingEndTime?: number;
  reservedBy?: { id?: number | string } | null;
  name?: string | null;
  approvalFlowId?: number | null;
  approvalStatus?: unknown;
  moduleState?: { id?: number | string; displayName?: string; name?: string } | null;
  isCancelled?: boolean | string | null;
}

/** State names that mean the booking is dead — orgs call it Cancelled, Rejected, Terminated, Declined, Void. */
const DEAD_STATE = /cancel|reject|terminat|declin|void/i;

/** The record's own cancelled flag, in either the boolean or the string form a projection may return. */
export function isCancelledRow(row: SpaceBookingRow): boolean {
  return row.isCancelled === true || String(row.isCancelled).toLowerCase() === 'true';
}

/**
 * The id of a CANCELLED state, learnt from a row that is in one — so the next request can leave
 * such rows out at the source. Null for a live row, or one whose state carries no id.
 */
export function cancelledStateIdOf(row: SpaceBookingRow): string | null {
  const name = stateName(row.moduleState);
  if (!(isCancelledRow(row) || (name && /cancel/i.test(name)))) return null;
  return row.moduleState?.id != null ? String(row.moduleState.id) : null;
}

/** Only the segments whose day falls inside the inclusive range — ISO dates compare as strings. */
export function clipSegmentsToRange(segments: Booking[], startISO: string, endISO: string): Booking[] {
  return segments.filter((b) => b.date >= startISO && b.date <= endISO);
}

export function isoPlusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * One org row → this app's bookings, on the org's wall clock.
 *
 * A booking that runs past midnight is ONE record spanning several days. Filed under its start
 * day and cut at midnight, a week-long desk booking read as "17:30–24:00" on day one and vanished
 * for the rest. It becomes one SEGMENT per covered day — 17:30→24:00, whole days, 00:00→17:30 —
 * every segment carrying the same record id, with `segIndex`/`segCount` so a list can show it once.
 *
 * Null for a row that holds no slot: no resource, no start time, cancelled (the record's own flag,
 * checked first and authoritative — whatever the org named the state) or in a dead state.
 * `approvalPending` is set when the record is under an approval flow and its status is unresolved
 * or reads as pending. `approvalStatus` must be a real lookup object: Facilio's unset sentinel is
 * -1, which alone would mark every plain booking pending.
 */
export function bookingSegmentsFromRow(row: SpaceBookingRow, tz: string | null, floorId: string = ''): Booking[] | null {
  const unitId = row.desk?.id ?? row.space?.id ?? row.parkingStall?.id;
  const startEpoch = row.bookingStartTime;
  if (unitId == null || unitId === '' || typeof startEpoch !== 'number' || !Number.isFinite(startEpoch)) return null;
  const recordStateName = stateName(row.moduleState);
  if (isCancelledRow(row) || (recordStateName && DEAD_STATE.test(recordStateName))) return null;

  const approvalStatusName = stateName(row.approvalStatus);
  const approvalEnabled = row.approvalFlowId != null && row.approvalFlowId !== -1 && row.approvalStatus != null && typeof row.approvalStatus === 'object';
  const approvalPending = approvalEnabled && (approvalStatusName === null || isPendingApprovalName(approvalStatusName));

  const wc = wallClockInTz(startEpoch, tz);
  const endEpoch = typeof row.bookingEndTime === 'number' && Number.isFinite(row.bookingEndTime) ? row.bookingEndTime : startEpoch;
  const durMin = Math.max(0, Math.round((endEpoch - startEpoch) / 60_000));
  // The last minute of the booking decides how many days it covers: a booking ending exactly at
  // midnight stays on its own day.
  const spanDays = Math.floor((wc.minutes + Math.max(durMin, 1) - 1) / 1440);
  const base = {
    id: String(row.id),
    unitId: String(unitId),
    floorId,
    by: row.reservedBy?.id != null ? String(row.reservedBy.id) : '',
    purpose: row.name ?? '',
    module: 'space' as const,
    name: row.name ?? '',
    approvalPending,
    approvalStatusName,
    stateName: recordStateName,
  };
  return Array.from({ length: spanDays + 1 }, (_, i) => ({
    ...base,
    date: i === 0 ? wc.dateISO : isoPlusDays(wc.dateISO, i),
    start: i === 0 ? wc.minutes : 0,
    end: Math.min(1440, wc.minutes + durMin - i * 1440),
    ...(spanDays > 0 ? { segIndex: i, segCount: spanDays + 1 } : {}),
  }));
}
