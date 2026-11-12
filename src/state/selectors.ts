import { CLOSED_RIGHTS, DEFAULT_ACCESS, SURFACE_ORDER, isModuleEnabled, isRoomLike, labelledType, unitOnPlan } from '../lib/types';
import { ROOM_FONT, subMaxChars, typographyOf } from '../lib/labelLayout';
import type { LabelTypography } from '../lib/labelLayout';
import type { LabelTextMeasure } from '../lib/textMeasure';
import type { MarkerLabelInput, RoomLabelInput } from '../lib/labelLayout';
import { polygonCentroid } from '../lib/geometry';
import type { Booking, Employee, Surface, Tab, Unit, UnitType } from '../lib/types';
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

/**
 * The department a space belongs to, for the plan's department filter: the record's own (a desk
 * carries one), else the department of the person who holds it. Most org desks have no
 * department of their own, so filtering on that alone offered nothing on most floors.
 */
export function unitDepartment(state: AppState, unit: Unit): string | null {
  const own = unit.department?.trim();
  if (own) return own;
  const holderId = state.assignments[unit.id];
  return (holderId ? contactById(state, holderId)?.department?.trim() : undefined) || null;
}

/** The departments on this floor, by name — what the department filter offers. */
export function floorDepartments(state: AppState): string[] {
  const names = new Set<string>();
  for (const u of visibleUnits(state)) {
    const d = unitDepartment(state, u);
    if (d) names.add(d);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The department the plan is filtered to, when it names one on this floor. One that has gone
 * (its last holder vacated, a module switched off) filters nothing rather than dimming the floor.
 */
export function activeDepartment(state: AppState): string | null {
  const d = state.spaceDepartment;
  if (!d) return null;
  return visibleUnits(state).some((u) => unitDepartment(state, u) === d) ? d : null;
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

const deskHoldings = new WeakMap<AppState['assignments'], { units: Unit[]; byPerson: Map<string, string> }>();

/**
 * The DESK the signed-in person holds — what "Your desk" and My desk point at. None while the org
 * hasn't said who they are.
 *
 * Desks only. It used to be the first unit of any kind they held, so someone holding a parking
 * stall (ENEC's admin account holds two) saw "Your desk" over the stall, on the parking floor
 * where they hold no desk at all.
 */
export function myAssignedUnit(state: AppState): Unit | null {
  if (!state.bookBy) return null;
  let held = deskHoldings.get(state.assignments);
  if (!held || held.units !== state.units) {
    // Built once per assignment map and unit list: every marker asks, on every model build.
    const desks = new Set(state.units.filter((u) => u.type === 'workstation').map((u) => u.id));
    const byPerson = new Map<string, string>();
    for (const [unitId, contactId] of Object.entries(state.assignments)) if (desks.has(unitId) && !byPerson.has(contactId)) byPerson.set(contactId, unitId);
    held = { units: state.units, byPerson };
    deskHoldings.set(state.assignments, held);
  }
  const mine = held.byPerson.get(state.bookBy);
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
  if (!showsHolder(state, unit)) return { holder: null, dept: null };
  const holderId = state.mode === 'assign' ? state.assignments[unit.id] : undefined;
  const contact = holderId ? contactById(state, holderId) : null;
  const name = personDisplayName(contact?.name);
  if (!name) return { holder: null, dept: null };
  const dept = departmentDisplayName(unit.department?.trim() || contact?.department);
  return { holder: shortPersonName(name, subMaxChars(typographyOf(state.labelStyle))), dept: dept || null };
}

/**
 * What planRoomLabels needs for each drawn room: its outline, the centroid RoomLabel draws its
 * name at, and the line under the name (the area in Edit, "Available" in Book). Shared by the
 * canvas and the print sheet, so paper shows the room names the screen shows at the same zoom.
 */
export function roomLabelInputs(state: AppState, rooms: Unit[], opts: { measure?: LabelTextMeasure } = {}): RoomLabelInput[] {
  const subHeight = state.mode === 'edit' || state.mode === 'book' ? 16 : 0;
  const measure = opts.measure;
  return rooms
    .filter((r) => r.geom.kind === 'poly' && r.geom.pts.length >= 3)
    .map((r) => {
      const pts = (r.geom as { pts: [number, number][] }).pts;
      const c = polygonCentroid(pts);
      // Measured in the page's font where there is one, so a long caps name ("HQ-BKC-4F-…") gets
      // exactly the width it needs and never loses its tail to an estimate.
      const name = unitPlanLabel(state, r);
      const longest = name.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '');
      return {
        id: r.id,
        pts,
        x: c.x,
        y: c.y,
        name,
        must: r.id === state.selected,
        subHeight,
        ...(measure ? { nameW: measure(name, ROOM_FONT, 600), wordW: measure(longest, ROOM_FONT, 600) } : {}),
      };
    });
}

/**
 * What the pin over a unit the signed-in person holds says, or null for any other unit: "Your desk"
 * over their desk, "Your parking" over each stall they hold. Lockers and rooms wear none.
 */
export function myPinText(state: AppState, unit: Unit): string | null {
  if (!state.bookBy) return null;
  if (unit.type === 'workstation') return myAssignedUnit(state)?.id === unit.id ? 'Your desk' : null;
  if (unit.type === 'parking') return state.assignments[unit.id] === state.bookBy ? 'Your parking' : null;
  return null;
}

/**
 * What a unit is called on the plan, screen and paper alike. A desk, stall or room says the record
 * field its Label on the plan setting names — a desk's Desk Code, a short "Stall Number" the org
 * added, a room's Code — in place of a long record name, and its name when that field is empty,
 * so nothing goes unlabelled. Lockers, delivery areas and markers keep their names.
 */
export function unitPlanLabel(state: AppState, unit: Unit): string {
  const kind = labelledType(unit.type);
  const field = kind ? state.planLabels[kind].field : 'name';
  if (!field || field === 'name') return unit.label;
  return unit.record?.[field]?.trim() || unit.label;
}

/** Whether the plan names who holds a unit: always, but for desks and stalls their Label on the plan setting can say not. */
export function showsHolder(state: AppState, unit: Unit): boolean {
  return unit.type === 'workstation' || unit.type === 'parking' ? state.planLabels[unit.type].showHolder : true;
}

/**
 * The label each marker WANTS, before `planMarkerLabels` decides which ones fit: its name above
 * (or the "Your desk" pill in its place), and the holder with their department below. Shared with
 * the print sheet so a label reads the same on paper as on screen.
 */
export function markerLabelInputs(state: AppState, markers: Unit[], opts: { personal?: boolean; /** The department filter: other departments' desks are dimmed and lose their cards. */ department?: string | null; measure?: LabelTextMeasure; /** The chip's screen size at the current zoom (see chipScreenSize); 24 when unsaid. */ chipSize?: number; /** The type the cards are drawn in at this zoom (see scaleTypography); the setting's own size when unsaid. */ typography?: LabelTypography } = {}): MarkerLabelInput[] {
  // `personal: false` (the print sheet): no "Your desk" pill — a sheet on a wall is read by everyone.
  const personal = opts.personal !== false;
  const labelsOn = state.mode === 'assign' || state.mode === 'book';
  const measure = opts.measure;
  const t = opts.typography ?? typographyOf(state.labelStyle);
  const dept = opts.department ?? null;
  return markers
    .filter((m) => labelsOn || m.type === 'amenity')
    .filter((m) => !dept || m.type === 'amenity' || m.id === state.selected || unitDepartment(state, m) === dept)
    .map((m) => {
      const g = m.geom as { x?: number; y?: number };
      const pillText = personal ? myPinText(state, m) : null;
      const mine = !!pillText;
      const { holder, dept } = markerSubTexts(state, m);
      const name = unitPlanLabel(state, m);
      return {
        id: m.id,
        x: g.x ?? 0,
        y: g.y ?? 0,
        size: opts.chipSize ?? 24,
        name,
        // "Your desk" stands above the chip; the card, with the desk's own name, goes elsewhere.
        pill: mine,
        ...(pillText ? { pillText } : {}),
        must: mine,
        sub: holder,
        dept,
        rank: m.id === state.selected ? 0 : mine ? 1 : 2,
        // Measured in the page's font where there is one, so the card is exactly as wide as its text.
        ...(measure
          ? {
              nameW: measure(name, t.nameFont, t.nameWeight),
              subW: holder ? measure(holder, t.subFont, t.subWeight) : undefined,
              deptW: dept ? measure(dept, t.deptFont, t.deptWeight) : undefined,
            }
          : {}),
      };
    });
}

/**
 * Whether the signed-in user reaches a tab.
 *
 * Open by default, deliberately: an unknown viewer role, an unconfigured surface and an org that
 * never opened the grid all mean "show it". Access is a setting someone turns ON for a reason, and
 * a failed read of the account payload must not empty the app.
 *
 * Except Settings, which is closed to a viewer whose role is unknown — the app's own URL opened
 * outside Facilio, or an account payload that names no role. Settings is where access itself is
 * changed, so "we could not tell who you are" must not open it. (Its writes are checked again on
 * the server: see functions/floorplanResponders.)
 */
export function canSee(state: AppState, surface: Surface): boolean {
  if (surface === 'settings' && !state.viewerRole) return false;
  const rule = state.access[surface] ?? DEFAULT_ACCESS[surface];
  if (rule.all) return true;
  // Assigning and booking are closed until granted, so a viewer we cannot place gets them only
  // when they are open to everyone. Denying them never empties the app — the plan still shows —
  // and granting them to "we could not tell who you are" would hand out exactly what was withheld.
  if (!state.viewerRole) return !CLOSED_RIGHTS.has(surface);
  // The org's admin roles never lose Settings, whatever the grid says — otherwise one bad save
  // locks out the only people who could undo it.
  if (surface === 'settings' && state.viewerRole.isAdmin) return true;
  return rule.roles.includes(state.viewerRole.id);
}

/** The tabs this viewer reaches, in nav order. Tabs only — editing is never somewhere to land. */
export function visibleSurfaces(state: AppState): Tab[] {
  return SURFACE_ORDER.filter((s) => canSee(state, s));
}

/**
 * The view to show. The one asked for when it is allowed, else the first tab that is — so a tab
 * hidden while someone is standing on it moves them somewhere real instead of rendering nothing.
 */
export function clampView(state: AppState, wanted: AppState['activeView']): AppState['activeView'] {
  if (canSee(state, wanted)) return wanted;
  return visibleSurfaces(state)[0] ?? 'map';
}

/**
 * Whether this viewer may edit the plan. Needs the plan as well as the edit right: editing a tab
 * you cannot open means nothing, and a role granted only the edit row has nowhere to use it.
 */
export function canEdit(state: AppState): boolean {
  return canSee(state, 'map') && canSee(state, 'map.edit');
}

/** Whether this viewer may assign and vacate from the plan (Floorplans › Assignment). */
export function canAssign(state: AppState): boolean {
  return canSee(state, 'map') && canSee(state, 'map.assign');
}

/** Whether this viewer may book from the plan (Floorplans › Booking). */
export function canBook(state: AppState): boolean {
  return canSee(state, 'map') && canSee(state, 'map.book');
}

/** Whether this viewer may book by selecting a slot in the Bookings calendar (Bookings › Book). */
export function canBookFromCalendar(state: AppState): boolean {
  return canSee(state, 'bookings') && canSee(state, 'bookings.book');
}

/**
 * Whether this booking form may be open, and sent: one opened from the calendar needs Bookings ›
 * Book, any other Floorplans › Booking (the plan, its sidebar, a scanned QR code).
 */
export function bookingAllowed(state: AppState, form: AppState['bookForm']): boolean {
  return form?.fromCalendar ? canBookFromCalendar(state) : state.planViews.book;
}
