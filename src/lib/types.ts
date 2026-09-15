export type UnitType = 'workstation' | 'locker' | 'parking' | 'room' | 'amenity' | 'delivery';
export type PlanId = 'workstation' | 'locker' | 'parking' | 'custom';

/**
 * Modules an org can switch off entirely (Settings › Modules). A disabled module disappears from
 * the whole app — canvas, legend, edit tools, filters, panels and its own settings tab — rather
 * than merely being empty, so an org that doesn't do parking never sees parking anywhere.
 *
 * `amenity` is deliberately not toggleable: those markers are wayfinding (stairs, extinguishers)
 * rather than a bookable/assignable module, and hiding them would strip the plan of its landmarks.
 */
export type ModuleKey = Exclude<UnitType, 'amenity'>;

export const TOGGLEABLE_MODULES: ModuleKey[] = ['workstation', 'room', 'locker', 'parking', 'delivery'];

export type EnabledModules = Record<ModuleKey, boolean>;

export const DEFAULT_ENABLED_MODULES: EnabledModules = {
  workstation: true,
  room: true,
  locker: true,
  parking: true,
  delivery: true,
};

/** Whether a unit's module is switched on. Amenity markers are never gated. */
export function isModuleEnabled(enabled: EnabledModules, type: UnitType): boolean {
  if (type === 'amenity') return true;
  return enabled[type] !== false;
}

/**
 * Zone-shaped modules — drawn as a polygon rather than a point marker, and reservable-or-assignable
 * via `isReservable` instead of a desk type. Rooms and delivery areas differ only in labelling.
 */
export function isRoomLike(type: UnitType): boolean {
  return type === 'room' || type === 'delivery';
}

/** Edit tools that draw a polygon zone rather than dropping a point marker. */
export function isZoneTool(tool: EditTool): boolean {
  return tool === 'room' || tool === 'delivery';
}

/**
 * Which plan a unit being PLACED belongs to.
 *
 * `Unit.plan` is the floorplan IMAGE a marker is drawn on — the canvas filters by it, and the org
 * sync converts the marker's 0-1 position through that plan's georeference quad. So it is decided
 * by the plan on screen when the point was picked, never by the unit's type: placing a desk while
 * the Lockers plan is open used to tag it `workstation`, which made it vanish from the plan the
 * user was looking at and wrote its locker-plan coordinates into the workstation plan's record.
 *
 * Room-like zones are plan-agnostic (they draw on every plan), so they keep `custom`.
 */
export function planForPlacement(currentPlan: PlanId, type: UnitType): PlanId {
  return isRoomLike(type) ? 'custom' : currentPlan;
}

/** Informational point markers (not assignable/bookable), shown on every plan type. */
export type AmenityIcon = 'asset' | 'fire' | 'stairs' | 'elevator' | 'restroom';

export const AMENITY_META: Record<AmenityIcon, { name: string; prefix: string; color: string }> = {
  asset: { name: 'Asset', prefix: 'AS', color: '#6d5bd0' },
  fire: { name: 'Fire extinguisher', prefix: 'FE', color: '#d64545' },
  stairs: { name: 'Stairs', prefix: 'ST', color: '#0d9488' },
  elevator: { name: 'Elevator', prefix: 'EL', color: '#c77d11' },
  restroom: { name: 'Restroom', prefix: 'RR', color: '#2f6fdb' },
};

export const AMENITY_ICONS: AmenityIcon[] = ['asset', 'fire', 'stairs', 'elevator', 'restroom'];

/**
 * A placeable facility-marker definition (Edit view › Markers tab). Built-ins ship with the app;
 * custom ones are user-created (persisted via settings). Rendering precedence per def:
 * `img` (photo chip) → `icon` (a MARKER_ICONS glyph key) → `text` (1–2 char label chip).
 */
export interface MarkerDef {
  id: string;
  name: string;
  color: string;
  /** 1–2 character chip label, e.g. "FE" for fire exit. */
  text?: string;
  /** Glyph key into MARKER_ICONS (built-ins only). */
  icon?: AmenityIcon;
  /** Image URL rendered as a round chip (custom markers). */
  img?: string;
}

export const BUILTIN_MARKERS: MarkerDef[] = [
  { id: 'stairs', name: 'Stairs', color: '#0EA5A5', icon: 'stairs' },
  { id: 'elevator', name: 'Elevator', color: '#C2761A', icon: 'elevator' },
  { id: 'restroom', name: 'Restroom', color: '#6D5AE6', icon: 'restroom' },
  { id: 'fire', name: 'Fire extinguisher', color: '#d64545', icon: 'fire' },
  { id: 'firstaid', name: 'First aid', color: '#29A01E', text: '+' },
  { id: 'fireexit', name: 'Fire exit', color: '#B61919', text: 'FE' },
  { id: 'printer', name: 'Printer', color: '#607796', text: 'PR' },
  { id: 'coffee', name: 'Pantry', color: '#B5761A', text: 'CF' },
  { id: 'reception', name: 'Reception', color: '#0059D6', text: 'RC' },
];

/**
 * The marker definition a unit renders with. Precedence: explicit markerKind (library id,
 * built-in or custom) → legacy `icon` (pre-library amenity units) → a grey "?" fallback so a
 * unit whose custom def was since deleted still renders and stays selectable.
 */
export function resolveMarkerDef(customMarkers: MarkerDef[], unit: Pick<Unit, 'markerKind' | 'icon'>): MarkerDef {
  const kind = unit.markerKind ?? unit.icon;
  if (kind) {
    const def = BUILTIN_MARKERS.find((m) => m.id === kind) ?? customMarkers.find((m) => m.id === kind);
    if (def) return def;
  }
  return { id: kind ?? 'unknown', name: 'Marker', color: '#607796', text: '?' };
}

/** Display name per plan type — shared by the plan-type switcher and the per-type empty state. */
export const PLAN_TYPE_NAME: Record<PlanId, string> = {
  workstation: 'Workstations',
  locker: 'Lockers',
  parking: 'Parking stalls',
  custom: 'Custom',
};

/** What you'd place on this plan type, for the empty-state copy ("...to start mapping {this}"). */
export const PLAN_TYPE_MAPS: Record<PlanId, string> = {
  workstation: 'desks',
  locker: 'lockers',
  parking: 'parking stalls',
  custom: 'rooms and other spaces',
};

/** The three real plan types, always offered in the switcher regardless of which are configured. */
export const ALL_PLAN_TYPES: { id: PlanId; name: string }[] = [
  { id: 'workstation', name: PLAN_TYPE_NAME.workstation },
  { id: 'locker', name: PLAN_TYPE_NAME.locker },
  { id: 'parking', name: PLAN_TYPE_NAME.parking },
];
export type AppMode = 'assign' | 'book' | 'edit';
export type EditTool = 'select' | 'room' | 'delivery' | 'workstation' | 'locker' | 'parking' | 'amenity' | 'asset' | 'calibrate';
export type Role = 'admin' | 'manager' | 'employee';

/** Each plan type on a floor can have its own background image — key floorImages by both. */
export function floorImageKey(floorId: string, planId: PlanId): string {
  return `${floorId}:${planId}`;
}

export interface PointGeom {
  kind: 'point';
  /** Fraction (0-1) of the floorplan image width/height. */
  x: number;
  y: number;
}

export interface PolyGeom {
  kind: 'poly';
  /** Fractions (0-1) of the floorplan image width/height. */
  pts: [number, number][];
}

export type UnitGeom = PointGeom | PolyGeom;

/**
 * Real Facilio desk typing (`V3DeskContext.DeskType`, see Context/Workplace_spaceModules.md):
 * ASSIGNED(1) / HOTEL(2) / HOT(3). ASSIGNED desks are permanently assignable and NOT bookable;
 * HOT and HOTEL desks are bookable (the backend auto-provisions a Facility for HOT) and NOT
 * assignable. An absent deskType is treated as ASSIGNED (the backend default).
 */
export type DeskType = 'ASSIGNED' | 'HOTEL' | 'HOT';
export const DESK_TYPES: { id: DeskType; name: string }[] = [
  { id: 'ASSIGNED', name: 'Assigned' },
  { id: 'HOTEL', name: 'Hotel' },
  { id: 'HOT', name: 'Hot' },
];

export interface Unit {
  id: string;
  type: UnitType;
  label: string;
  secondary?: string;
  room: string | null;
  geom: UnitGeom;
  floor: string;
  plan: PlanId;
  /**
   * True for records that exist in the org but have no on-plan position yet — e.g. desks/rooms
   * read from the CMMS connector's spaces (their `geom` is a 0,0 placeholder). Listed in the
   * sidebar with their real type, but NOT drawn on the canvas (positions come from the
   * floorplanmarker / facilio-iwms path). Distinct from the edit-mode "Available to place" pool.
   */
  unplaced?: boolean;
  /** Workstations only — see DeskType. Undefined = ASSIGNED. */
  deskType?: DeskType;
  /** Amenity markers only — which glyph the marker renders (legacy built-in five). */
  icon?: AmenityIcon;
  /** Amenity markers placed from the marker library — MarkerDef id (built-in or custom). */
  markerKind?: string;
  /** Asset-associated markers — id of the linked asset (see lib/assets). */
  assetId?: string;
  /** Rooms only — from the IWMS rooms module. true (or undefined) = bookable; false = assignable. */
  isReservable?: boolean;
}

export interface Employee {
  id: string;
  name: string;
}

export interface Booking {
  id: string;
  unitId: string;
  date: string;
  /** Minutes from midnight. */
  start: number;
  end: number;
  /** Short summary fields the calendar/markers read directly (derived from the form below). */
  by: string;
  purpose: string;
  // ---- Full booking-form detail, persisted to the vibe-db. Optional so quick/calendar drags
  // (which only capture a time window) and older stored rows stay valid. ----
  /** 'space' -> spacebooking form, 'facility' -> facilitybooking form. */
  module?: 'space' | 'facility';
  /** Booking name/title (the form's required "Name"). */
  name?: string;
  description?: string;
  /** Employee id hosting the booking (space mode). */
  host?: string;
  /** Employee id the booking is reserved by/for. */
  reservedBy?: string;
  noOfAttendees?: number;
  /** Employee ids. */
  internalAttendees?: string[];
  /** Employee ids (or free-text) for external attendees. */
  externalAttendees?: string[];
}

/** unitId -> employeeId */
export type Assignments = Record<string, string>;

export interface Floor {
  id: string;
  name: string;
  hasPlan?: boolean;
  plans?: { id: PlanId; name: string }[];
}

/**
 * `floors` / `buildings` are OPTIONAL: `undefined` means "not fetched yet", `[]` means "fetched and
 * empty". The org has hundreds of buildings and floors, so the tree loads a level on demand — a
 * site's buildings when it is expanded, a building's floors when it is. Every walker must treat a
 * missing array as "unknown", not "none".
 */
export interface Building {
  id: string;
  name: string;
  floors?: Floor[];
}

export interface Site {
  id: string;
  name: string;
  buildings?: Building[];
}

/** One hit from the portfolio search: a floor plus the path needed to open it in the tree. */
export interface FloorSearchHit {
  floorId: string;
  floorName: string;
  buildingId: string;
  buildingName: string;
  siteId: string;
  siteName: string;
}

export interface PanelLayoutState {
  open: boolean;
  x: number | null;
  y: number | null;
}

export interface PanelsState {
  context: PanelLayoutState;
  portfolio: PanelLayoutState;
  details: PanelLayoutState;
}

export interface ViewTransform {
  tx: number;
  ty: number;
  z: number;
}

export const TYPE_META: Record<UnitType, { name: string; prefix: string }> = {
  workstation: { name: 'Desk', prefix: 'WS' },
  locker: { name: 'Locker', prefix: 'L' },
  parking: { name: 'Parking stall', prefix: 'P' },
  room: { name: 'Room', prefix: 'RM' },
  delivery: { name: 'Delivery area', prefix: 'DA' },
  amenity: { name: 'Amenity', prefix: 'AM' },
};

export const ROLES: { id: Role; name: string }[] = [
  { id: 'admin', name: 'Admin' },
  { id: 'manager', name: 'Manager' },
  { id: 'employee', name: 'Employee' },
];

export type PermsAction = 'edit' | 'assign' | 'book';
export type Perms = Record<PermsAction, Role[]>;

export const DEFAULT_PERMS: Perms = {
  edit: ['admin'],
  assign: ['admin', 'manager'],
  book: ['admin', 'manager', 'employee'],
};

export const ACTIONS: { id: PermsAction; name: string; desc: string }[] = [
  { id: 'edit', name: 'Edit floorplan', desc: 'Draw rooms, place units, calibrate scale' },
  { id: 'assign', name: 'Assign desks & lockers', desc: 'Give a permanent desk or locker to a person' },
  { id: 'book', name: 'Book spaces', desc: 'Reserve hot desks, rooms, parking' },
];

export interface StateDef {
  key: string;
  label: string;
  desc: string;
  def: string;
}

export const STATE_SWATCHES = ['#29A01E', '#0059D6', '#3C229D', '#B61919', '#F59E0B', '#2ED1FF', '#607796'];

export const STATE_DEFS: Record<UnitType, StateDef[]> = {
  workstation: [
    { key: 'free', label: 'Free', desc: 'Assignable, no owner yet', def: '#29A01E' },
    { key: 'assigned', label: 'Assigned', desc: 'Has a permanent owner', def: '#0059D6' },
    { key: 'hot', label: 'Hot desk', desc: 'Bookable by anyone, per session', def: '#3C229D' },
    { key: 'booked', label: 'Booked', desc: 'Reserved for a time window', def: '#B61919' },
  ],
  locker: [
    { key: 'free', label: 'Free', desc: 'Available to assign', def: '#29A01E' },
    { key: 'assigned', label: 'Assigned', desc: 'Held by an employee', def: '#0059D6' },
  ],
  parking: [
    { key: 'free', label: 'Free', desc: 'Open stall', def: '#29A01E' },
    { key: 'assigned', label: 'Assigned', desc: 'Allotted to an employee', def: '#0059D6' },
    { key: 'booked', label: 'Booked', desc: 'Reserved for a time window', def: '#B61919' },
  ],
  room: [
    { key: 'available', label: 'Available', desc: 'Open to book', def: '#29A01E' },
    { key: 'booked', label: 'Booked', desc: 'Reserved for a time window', def: '#B61919' },
    { key: 'free', label: 'Free', desc: 'Not reservable — open to assign', def: '#29A01E' },
    { key: 'assigned', label: 'Assigned', desc: 'Not reservable — has a permanent owner', def: '#0059D6' },
  ],
  delivery: [
    { key: 'available', label: 'Available', desc: 'Open to book a drop-off slot', def: '#29A01E' },
    { key: 'booked', label: 'Booked', desc: 'Reserved for a time window', def: '#B61919' },
    { key: 'free', label: 'Free', desc: 'Not reservable — open to assign', def: '#29A01E' },
    { key: 'assigned', label: 'Assigned', desc: 'Not reservable — has a permanent holder', def: '#0059D6' },
  ],
  amenity: [{ key: 'free', label: 'Marker', desc: 'Informational marker (stairs, restrooms, extinguishers, …)', def: '#607796' }],
};

export interface OptDef {
  key: string;
  label: string;
  desc: string;
  def: boolean;
}

export const OPT_DEFS: Record<UnitType, OptDef[]> = {
  workstation: [
    { key: 'hotDesking', label: 'Allow hot-desking', desc: 'Let employees book unassigned desks by the hour', def: true },
    { key: 'autoRelease', label: 'Auto-release no-shows', desc: 'Free a booked desk 30 min after an unclaimed start', def: true },
  ],
  locker: [
    { key: 'deposit', label: 'Require deposit', desc: 'Collect a refundable deposit on assignment', def: false },
    { key: 'autoExpire', label: 'Expire idle lockers', desc: 'Release lockers unused for 90 days', def: true },
  ],
  parking: [
    { key: 'evOnly', label: 'EV stalls need a permit', desc: 'Restrict charging stalls to permit holders', def: true },
    { key: 'overnight', label: 'Allow overnight parking', desc: 'Permit bookings that span midnight', def: false },
  ],
  room: [
    { key: 'approval', label: 'Require approval', desc: 'Route room requests to a facilities admin', def: false },
    { key: 'checkin', label: 'Require check-in', desc: 'Auto-cancel if nobody checks in within 10 min', def: true },
  ],
  delivery: [
    { key: 'approval', label: 'Require approval', desc: 'Route drop-off requests to a facilities admin', def: true },
    { key: 'dock', label: 'Enforce dock capacity', desc: 'Block overlapping bookings past the bay count', def: true },
  ],
  amenity: [],
};
