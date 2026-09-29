import { isModuleEnabled, isRoomLike, unitOnPlan } from '../lib/types';
import { SUB_MAX_CHARS } from '../lib/labelLayout';
import type { MarkerLabelInput } from '../lib/labelLayout';
import type { Booking, Employee, Unit, UnitType } from '../lib/types';
import type { AppState } from './types';
import { departmentDisplayName, personDisplayName, personInitials, shortPersonName } from '../lib/displayNames';

export function unitById(state: AppState, id: string | null | undefined): Unit | null {
  if (!id) return null;
  return state.units.find((u) => u.id === id) ?? null;
}

/**
 * Whether a module is switched on for this org (Settings › Modules). Every surface that lists or
 * draws units goes through this or `visibleUnits` — a disabled module must leave no trace, so the
 * gate belongs next to the data rather than repeated as an ad-hoc check per component.
 */
export function moduleEnabled(state: AppState, type: UnitType): boolean {
  return isModuleEnabled(state.enabledModules, type);
}

/** The units any surface should render: those whose module is switched on. */
export function visibleUnits(state: AppState): Unit[] {
  return state.units.filter((u) => moduleEnabled(state, u.type));
}

/** Unit types that are switched on, in the given order — for filter chips, tabs and legends. */
export function enabledTypes(state: AppState, types: UnitType[]): UnitType[] {
  return types.filter((t) => moduleEnabled(state, t));
}

export function contactById(state: AppState, id: string | null | undefined): Employee | null {
  if (!id) return null;
  return state.employees.find((c) => c.id === id) ?? null;
}

/**
 * The name to SHOW for a person — without the employee number the org's records put in front of
 * it ("251850 - Johar Ali" reads "Johar Ali"; see lib/displayNames). Display only: anything that
 * matches or searches reads the record's own `name`.
 */
export function contactName(state: AppState, id: string | null | undefined): string {
  return personDisplayName(contactById(state, id)?.name);
}

/** Chip and avatar initials, from the name and never from its employee number. */
export function initials(name: string): string {
  return personInitials(name);
}

/** Units with any booking overlapping [start,end) on `date`. */
export function conflictsFor(bookings: Booking[], unitId: string, date: string, start: number, end: number): Booking[] {
  return bookings.filter((b) => b.unitId === unitId && b.date === date && b.start < end && b.end > start);
}

export function bookedUnitIds(state: AppState): Set<string> {
  const set = new Set<string>();
  for (const b of state.bookings) {
    if (b.date === state.date && b.start < state.end && b.end > state.start) set.add(b.unitId);
  }
  return set;
}

/**
 * Desk bookability/assignability follows the real deskType semantics (see lib/types DeskType):
 * ASSIGNED (or untyped) desks are assignment-only; HOT/HOTEL desks are booking-only. Parking
 * stays bookable; lockers stay assignment-only. Rooms follow their own `isReservable` flag (from
 * the IWMS rooms module): bookable unless explicitly marked not-reservable, in which case they're
 * assignable instead — mutually exclusive, same as desks.
 *
 * A room read from the org (`orgRoom`: its outline zone, or its `space` record) is NEITHER, for
 * now: a booking of it has no spacebooking mapping (createRealBooking), and an assignment none
 * either, so both would be kept in this browser only while the plan called the room booked or
 * assigned. Its `isReservable` is carried as read, but says nothing about what this app can do.
 */
export function isBookable(u: Unit): boolean {
  if (u.type === 'locker' || u.type === 'amenity') return false;
  if (u.type === 'workstation') return u.deskType === 'HOT' || u.deskType === 'HOTEL';
  if (isRoomLike(u.type)) return !u.orgRoom && u.isReservable !== false;
  return true;
}

export function isAssignable(u: Unit): boolean {
  if (u.type === 'workstation') return (u.deskType ?? 'ASSIGNED') === 'ASSIGNED';
  if (isRoomLike(u.type)) return !u.orgRoom && u.isReservable === false;
  return u.type === 'locker' || u.type === 'parking';
}

export function myAssignedUnit(state: AppState): Unit | null {
  const mine = Object.entries(state.assignments).find(([, contactId]) => contactId === state.bookBy);
  if (!mine) return null;
  return unitById(state, mine[0]);
}

export function floorMeta(state: AppState, floorId: string) {
  for (const site of state.portfolio) {
    for (const building of site.buildings ?? []) {
      const floor = (building.floors ?? []).find((f) => f.id === floorId);
      if (floor) return { site, building, floor };
    }
  }
  return null;
}

export function nextLabel(state: AppState, type: Unit['type'], prefix: string): string {
  const count = state.units.filter((u) => u.type === type).length;
  return `${prefix}-${String(count + 1).padStart(2, '0')}`;
}

/**
 * What the plan draws — shared by the canvas and the print sheet so paper and screen cannot
 * disagree about what is on the floor.
 *
 * Rooms: traced polygons, on the plan type they were traced over (their outline is in that
 * image's coordinates). Markers: everything else that has a position — amenities on every plan
 * type, desks/lockers/parking only on theirs, and never an `unplaced` record, whose geometry is a
 * 0,0 placeholder.
 */
export function planRooms(state: AppState): Unit[] {
  return visibleUnits(state).filter((u) => isRoomLike(u.type) && u.geom.kind === 'poly' && unitOnPlan(u, state.planId));
}

export function planMarkers(state: AppState): Unit[] {
  return visibleUnits(state).filter((u) => !isRoomLike(u.type) && !u.unplaced && (u.type === 'amenity' || unitOnPlan(u, state.planId)));
}

/**
 * What a desk says UNDER its chip in Assignment view: who holds it, and their department — one
 * function for the layout that measures it and the marker that draws it, so what was measured is
 * what is drawn, on screen and on paper alike.
 *
 * The holder is the name without its employee number, shortened to first name + surname when it
 * would not fit a label ("Abdulrahman Abdullah Khalaf AlAnazi" → "Abdulrahman AlAnazi"); the full
 * name is on the chip's tooltip. The department is the desk's own, else the holder's, without
 * its cost-centre code.
 */
export function markerSubTexts(state: AppState, unit: Unit): { holder: string | null; dept: string | null } {
  const holderId = state.mode === 'assign' ? state.assignments[unit.id] : undefined;
  const contact = holderId ? contactById(state, holderId) : null;
  const name = personDisplayName(contact?.name);
  if (!name) return { holder: null, dept: null };
  const dept = departmentDisplayName(unit.department?.trim() || contact?.department);
  return { holder: shortPersonName(name, SUB_MAX_CHARS), dept: dept || null };
}

/**
 * The label each marker WANTS, before `planMarkerLabels` decides which ones fit: its name above
 * (or the "Your desk" pill in its place), and the holder with their department below. Shared with
 * the print sheet so a label reads the same on paper as on screen.
 */
export function markerLabelInputs(state: AppState, markers: Unit[], opts: { personal?: boolean } = {}): MarkerLabelInput[] {
  // `personal: false` (the print sheet): no "Your desk" pill — the desk shows its own name.
  const mineId = opts.personal === false ? null : (myAssignedUnit(state)?.id ?? null);
  const labelsOn = state.mode === 'assign' || state.mode === 'book';
  return markers
    .filter((m) => labelsOn || m.type === 'amenity')
    .map((m) => {
      const g = m.geom as { x?: number; y?: number };
      const mine = m.id === mineId;
      const { holder, dept } = markerSubTexts(state, m);
      return {
        id: m.id,
        x: g.x ?? 0,
        y: g.y ?? 0,
        size: 24,
        // "Your desk" replaces the name label rather than stacking above it.
        name: mine ? 'Your desk' : m.label,
        pill: mine,
        must: mine,
        sub: holder,
        dept,
        rank: m.id === state.selected ? 0 : mine ? 1 : 2,
      };
    });
}
