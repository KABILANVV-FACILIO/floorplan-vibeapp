import { isModuleEnabled, isRoomLike, unitOnPlan } from '../lib/types';
import { DEPT_FONT, DEPT_WEIGHT, NAME_FONT, NAME_WEIGHT, SUB_FONT, SUB_MAX_CHARS, SUB_WEIGHT } from '../lib/labelLayout';
import type { LabelTextMeasure } from '../lib/textMeasure';
import type { MarkerLabelInput, RoomLabelInput } from '../lib/labelLayout';
import { polygonCentroid } from '../lib/geometry';
import type { Booking, Employee, Unit, UnitType } from '../lib/types';
import type { AppState } from './types';
import { departmentDisplayName, personDisplayName, personInitials, shortPersonName } from '../lib/displayNames';

/*
 * Lookups by id, indexed once per array and cached on the array itself (a WeakMap, so a replaced
 * array simply gets a new index and the old one is collected). Every marker on the plan asks for
 * its holder, its unit and whether it is the user's own desk on every render; against a roster of
 * 2,600 employees a linear `find` per marker per frame was most of what made panning a 400-desk
 * floor drop frames.
 */
const employeeIndexes = new WeakMap<Employee[], Map<string, Employee>>();
export function employeeIndex(employees: Employee[]): Map<string, Employee> {
  let m = employeeIndexes.get(employees);
  if (!m) {
    m = new Map(employees.map((e) => [e.id, e]));
    employeeIndexes.set(employees, m);
  }
  return m;
}
const unitIndexes = new WeakMap<Unit[], Map<string, Unit>>();
export function unitIndex(units: Unit[]): Map<string, Unit> {
  let m = unitIndexes.get(units);
  if (!m) {
    m = new Map(units.map((u) => [u.id, u]));
    unitIndexes.set(units, m);
  }
  return m;
}
/** Which unit each person holds — the first one, as `Object.entries(...).find` answered. */
const holdings = new WeakMap<AppState['assignments'], Map<string, string>>();
export function unitHeldBy(assignments: AppState['assignments']): Map<string, string> {
  let m = holdings.get(assignments);
  if (!m) {
    m = new Map();
    for (const [unitId, contactId] of Object.entries(assignments)) if (!m.has(contactId)) m.set(contactId, unitId);
    holdings.set(assignments, m);
  }
  return m;
}
const selectionSets = new WeakMap<string[], Set<string>>();
export function multiSelectedSet(ids: string[]): Set<string> {
  let s = selectionSets.get(ids);
  if (!s) {
    s = new Set(ids);
    selectionSets.set(ids, s);
  }
  return s;
}

export function unitById(state: AppState, id: string | null | undefined): Unit | null {
  if (!id) return null;
  return unitIndex(state.units).get(id) ?? null;
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
  return employeeIndex(state.employees).get(id) ?? null;
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
 * A room read from the org (`orgRoom`: its outline zone, or its `space` record) is bookable only
 * when its record SAYS so — `reservable` on the space — because a booking of it is a real
 * spacebooking on that space (createRealBooking). It is never assignable here: an assignment of
 * an org room has no write behind it, and would be kept in this browser only while the plan
 * called the room assigned.
 */
export function isBookable(u: Unit): boolean {
  if (u.type === 'locker' || u.type === 'amenity') return false;
  if (u.type === 'workstation') return u.deskType === 'HOT' || u.deskType === 'HOTEL';
  if (isRoomLike(u.type)) return u.orgRoom ? u.isReservable === true : u.isReservable !== false;
  return true;
}

/**
 * The loaded floor's units plus every org record not among them. A placed unit wins on an id
 * collision (it carries the richer data), but takes the pool twin's `reservable` flag when its
 * own is unknown — that flag is what makes a room bookable.
 */
export function mergeWithOrgPool(local: Unit[], pool: Unit[]): Unit[] {
  const byId = new Map(pool.map((u) => [u.id, u]));
  const merged = local.map((u) => {
    const twin = byId.get(u.id);
    return u.isReservable === undefined && twin?.isReservable !== undefined ? { ...u, isReservable: twin.isReservable } : u;
  });
  const localIds = new Set(local.map((u) => u.id));
  return [...merged, ...pool.filter((u) => !localIds.has(u.id))];
}

export function isAssignable(u: Unit): boolean {
  if (u.type === 'workstation') return (u.deskType ?? 'ASSIGNED') === 'ASSIGNED';
  if (isRoomLike(u.type)) return !u.orgRoom && u.isReservable === false;
  return u.type === 'locker' || u.type === 'parking';
}

export function myAssignedUnit(state: AppState): Unit | null {
  const mine = unitHeldBy(state.assignments).get(state.bookBy);
  return mine ? unitById(state, mine) : null;
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

/**
 * The name a newly drawn unit gets: `<prefix>-<n>`, n one past the units of that type on the floor.
 * Rooms read from the org (`orgRoom`) are not counted — they carry the org's own names, and since
 * the floor load draws every org outline as a placed room, counting them would name a room traced
 * on a floor with 12 outlines "RM-13" where it has always been "RM-01" (and send that name to the
 * connector's create-space). The one remaining difference: a pool room traced this session no
 * longer counts either.
 */
export function nextLabel(state: AppState, type: Unit['type'], prefix: string): string {
  const count = state.units.filter((u) => u.type === type && !u.orgRoom).length;
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
 * What planRoomLabels needs for each drawn room: its outline, the centroid RoomLabel draws its
 * name at, and the line under the name (the area in Edit, "Available" in Book). Shared by the
 * canvas and the print sheet, so paper shows the room names the screen shows at the same zoom.
 */
export function roomLabelInputs(state: AppState, rooms: Unit[]): RoomLabelInput[] {
  const subHeight = state.mode === 'edit' || state.mode === 'book' ? 16 : 0;
  return rooms
    .filter((r) => r.geom.kind === 'poly' && r.geom.pts.length >= 3)
    .map((r) => {
      const pts = (r.geom as { pts: [number, number][] }).pts;
      const c = polygonCentroid(pts);
      return { id: r.id, pts, x: c.x, y: c.y, name: r.label, must: r.id === state.selected, subHeight };
    });
}

/**
 * The label each marker WANTS, before `planMarkerLabels` decides which ones fit: its name above
 * (or the "Your desk" pill in its place), and the holder with their department below. Shared with
 * the print sheet so a label reads the same on paper as on screen.
 */
export function markerLabelInputs(state: AppState, markers: Unit[], opts: { personal?: boolean; measure?: LabelTextMeasure } = {}): MarkerLabelInput[] {
  // `personal: false` (the print sheet): no "Your desk" pill — a sheet on a wall is read by everyone.
  const mineId = opts.personal === false ? null : (myAssignedUnit(state)?.id ?? null);
  const labelsOn = state.mode === 'assign' || state.mode === 'book';
  const measure = opts.measure;
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
        name: m.label,
        // "Your desk" stands above the chip; the card, with the desk's own name, goes elsewhere.
        pill: mine,
        must: mine,
        sub: holder,
        dept,
        rank: m.id === state.selected ? 0 : mine ? 1 : 2,
        // Measured in the page's font where there is one, so the card is exactly as wide as its text.
        ...(measure
          ? {
              nameW: measure(m.label, NAME_FONT, NAME_WEIGHT),
              subW: holder ? measure(holder, SUB_FONT, SUB_WEIGHT) : undefined,
              deptW: dept ? measure(dept, DEPT_FONT, DEPT_WEIGHT) : undefined,
            }
          : {}),
      };
    });
}
