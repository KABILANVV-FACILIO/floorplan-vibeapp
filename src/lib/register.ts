import type { Booking, Employee, RegisterKind, RegisterPrint, Unit } from './types';
import { orgTimezone, wallClockInTz } from './orgTime';
import { fmtTime } from './geometry';

/**
 * The registers — the pages printed after a plan (print window › Details): one row per desk, stall,
 * locker or room on the plan, a column per detail the person printing ticks, each kind with its own
 * choices. The plan itself has room for a label and a line under it; everything else is read here.
 *
 * Every value is the org's own: the space's record (Unit.record, read with the floor), the assigned
 * person's employee record (the roster) and, for a room, its booking in the window on screen.
 * Nothing is invented for an empty field — the page prints a dash.
 */

export type RegisterGroup = string;

export interface RegisterColumn {
  key: string;
  group: RegisterGroup;
  label: string;
  /** The page's column header, when the full label would not fit it (the group header says the rest). */
  head?: string;
  /** Relative width on the page. */
  width: number;
  /** Always printed, not offered as a choice. */
  locked?: boolean;
}

/** One kind of register: what it lists, its columns by where they come from, and how it is named. */
export interface RegisterCatalog {
  /** A row, a heading for the count, and the register's name on its pages. */
  one: string;
  many: string;
  title: string;
  groups: { key: RegisterGroup; label: string }[];
  columns: RegisterColumn[];
  /** The Details window's choice of rows, and how the page's filter line says it. */
  rowChoices: Record<RegisterPrint['rows'], string>;
  rowsText: Record<RegisterPrint['rows'], string>;
  /** The sorts the Details window offers, and how the page's filter line says each. */
  sorts: { value: RegisterPrint['sort']; label: string; text: string }[];
  /** The page's footnote: where the values come from. */
  source: string;
}

/** What a person holding a desk, stall or locker brings: their employee record. */
const PERSON: RegisterColumn[] = [
  { key: 'emp', group: 'person', label: 'Assigned to', width: 1.7 },
  { key: 'hrms', group: 'person', label: 'HRMS ID', width: 1.25 },
  { key: 'dept', group: 'person', label: 'Department', width: 1.8 },
  { key: 'desig', group: 'person', label: 'Designation', width: 1.4 },
  { key: 'grade', group: 'person', label: 'Grade', width: 0.6 },
  { key: 'mobile', group: 'person', label: 'Mobile', width: 1.75 },
  { key: 'email', group: 'person', label: 'Email', width: 2.2 },
  { key: 'lm', group: 'person', label: 'Line manager', width: 1.6 },
];
const HELD_SORTS = (one: string): RegisterCatalog['sorts'] => [
  { value: 'name', label: one[0].toUpperCase() + one.slice(1), text: one },
  { value: 'status', label: 'Status', text: 'status' },
  { value: 'dept', label: 'Department', text: 'department' },
  { value: 'emp', label: 'Assigned person', text: 'assigned person' },
];
const held = (one: string, many: string): Pick<RegisterCatalog, 'rowChoices' | 'rowsText'> => ({
  rowChoices: { all: `All ${many}`, assigned: 'Assigned only', vacant: 'Vacant only' },
  rowsText: { all: `All ${many}`, assigned: `Assigned ${many} only`, vacant: `Vacant ${many} only` },
});
const SOURCE_TAIL = 'at the time of printing. A dash means the record leaves it empty.';

export const REGISTERS: Record<RegisterKind, RegisterCatalog> = {
  parking: {
    one: 'stall',
    many: 'stalls',
    title: 'Parking register',
    groups: [
      { key: 'stall', label: 'Stall' },
      { key: 'person', label: 'Assigned person' },
      { key: 'dates', label: 'Dates' },
    ],
    columns: [
      { key: 'name', group: 'stall', label: 'Stall name', width: 2.2, locked: true },
      { key: 'id', group: 'stall', label: 'Record ID', width: 1 },
      { key: 'qr', group: 'stall', label: 'QR value', width: 2.1 },
      { key: 'type', group: 'stall', label: 'Parking type', head: 'Type', width: 1.25 },
      { key: 'mode', group: 'stall', label: 'Parking mode', head: 'Mode', width: 1.3 },
      { key: 'status', group: 'stall', label: 'Status', width: 1.2 },
      { key: 'area', group: 'stall', label: 'Area', width: 0.6 },
      { key: 'loc', group: 'stall', label: 'Location', width: 2.4 },
      ...PERSON,
      { key: 'since', group: 'dates', label: 'Occupied since', head: 'Occupied', width: 1.3 },
      { key: 'released', group: 'dates', label: 'Released on', head: 'Released', width: 1.3 },
    ],
    ...held('stall', 'stalls'),
    sorts: HELD_SORTS('stall'),
    source: `From the parking stall records and each assigned person’s employee record, ${SOURCE_TAIL}`,
  },
  workstation: {
    one: 'desk',
    many: 'desks',
    title: 'Desk register',
    groups: [
      { key: 'desk', label: 'Desk' },
      { key: 'person', label: 'Assigned person' },
    ],
    columns: [
      { key: 'name', group: 'desk', label: 'Desk name', width: 2.2, locked: true },
      { key: 'id', group: 'desk', label: 'Record ID', width: 1 },
      { key: 'code', group: 'desk', label: 'Desk code', head: 'Code', width: 1.2 },
      { key: 'qr', group: 'desk', label: 'QR value', width: 2.1 },
      { key: 'dtype', group: 'desk', label: 'Desk type', head: 'Type', width: 1.1 },
      { key: 'ddept', group: 'desk', label: 'Desk department', head: 'Desk dept.', width: 1.7 },
      { key: 'status', group: 'desk', label: 'Status', width: 1.2 },
      { key: 'room', group: 'desk', label: 'Room', width: 1.7 },
      { key: 'loc', group: 'desk', label: 'Location', width: 2.4 },
      ...PERSON,
    ],
    ...held('desk', 'desks'),
    sorts: HELD_SORTS('desk'),
    source: `From the desk records and each assigned person’s employee record, ${SOURCE_TAIL}`,
  },
  locker: {
    one: 'locker',
    many: 'lockers',
    title: 'Locker register',
    groups: [
      { key: 'locker', label: 'Locker' },
      { key: 'person', label: 'Assigned person' },
    ],
    columns: [
      { key: 'name', group: 'locker', label: 'Locker name', width: 2.2, locked: true },
      { key: 'id', group: 'locker', label: 'Record ID', width: 1 },
      { key: 'status', group: 'locker', label: 'Status', width: 1.2 },
      { key: 'room', group: 'locker', label: 'Room', width: 1.7 },
      { key: 'loc', group: 'locker', label: 'Location', width: 2.4 },
      ...PERSON,
    ],
    ...held('locker', 'lockers'),
    sorts: HELD_SORTS('locker'),
    source: `From the lockers and each assigned person’s employee record, ${SOURCE_TAIL}`,
  },
  room: {
    one: 'room',
    many: 'rooms',
    title: 'Room register',
    groups: [
      { key: 'room', label: 'Room' },
      { key: 'booking', label: 'Booking' },
    ],
    columns: [
      { key: 'name', group: 'room', label: 'Room name', width: 2.4, locked: true },
      { key: 'id', group: 'room', label: 'Record ID', width: 1 },
      { key: 'code', group: 'room', label: 'Code', width: 1.2 },
      { key: 'bookable', group: 'room', label: 'Bookable', width: 0.9 },
      { key: 'status', group: 'room', label: 'Status', width: 1.1 },
      { key: 'loc', group: 'room', label: 'Location', width: 2.4 },
      { key: 'by', group: 'booking', label: 'Booked by', width: 1.8 },
      { key: 'time', group: 'booking', label: 'Time', width: 1.3 },
      { key: 'purpose', group: 'booking', label: 'Purpose', width: 2.2 },
    ],
    // A room is not held: it is booked, or free, in the date and hours picked in the toolbar.
    rowChoices: { all: 'All rooms', assigned: 'Booked only', vacant: 'Free only' },
    rowsText: { all: 'All rooms', assigned: 'Booked rooms only', vacant: 'Free rooms only' },
    sorts: [
      { value: 'name', label: 'Room', text: 'room' },
      { value: 'status', label: 'Status', text: 'status' },
      { value: 'emp', label: 'Booked by', text: 'who booked it' },
    ],
    source: `From the room records and their bookings in the window printed, ${SOURCE_TAIL}`,
  },
};

/** The parking register's groups and columns, as before there were others. */
export const REGISTER_GROUPS = REGISTERS.parking.groups;
export const REGISTER_COLUMNS = REGISTERS.parking.columns;

/** Each kind's record field behind its record columns (ENEC's parkingstall, desks and space modules). */
const RECORD_FIELD: Record<RegisterKind, Record<string, string>> = {
  parking: {
    qr: 'qrVal',
    type: 'parkingType',
    mode: 'parkingMode',
    status: 'moduleState',
    area: 'area',
    since: 'occupied_time_parkingstall',
    released: 'released_time_parkingstall',
  },
  workstation: { code: 'deskCode', qr: 'qrVal' },
  locker: {},
  room: { code: 'code_space' },
};
const DATE_COLUMNS = new Set(['since', 'released']);
const PICKLIST_COLUMNS = new Set(['type', 'mode']);
const DESK_TYPE: Record<string, string> = { ASSIGNED: 'Assigned', HOTEL: 'Hotel', HOT: 'Hot desk' };

/**
 * The columns this print carries, in register order. When the plan labels its spaces by another
 * field (Settings › Desks / Parking / Rooms), that field prints next to the name, always: it is
 * what the reader found on the plan, and the register is where they look it up.
 */
export function registerColumns(print: RegisterPrint, labelField: { name: string; label: string } | null, kind: RegisterKind = 'parking'): RegisterColumn[] {
  const catalog = REGISTERS[kind];
  const chosen = catalog.columns.filter((c) => c.locked || print.cols.includes(c.key));
  if (!labelField || labelField.name === 'name') return chosen;
  const label: RegisterColumn = { key: 'label', group: chosen[0].group, label: labelField.label, width: 1.35, locked: true };
  return [chosen[0], label, ...chosen.slice(1)];
}

export interface RegisterContext {
  /** Which register this is; parking when unsaid. */
  kind?: RegisterKind;
  /** The plan's label for a space (see selectors.unitPlanLabel). */
  planLabel: (u: Unit) => string;
  /** The field the plan labels this kind with, when it is not the name. */
  labelField: string | null;
  holderOf: (u: Unit) => Employee | null;
  personById: (id: string) => Employee | null;
  /** A room's booking in the window printed (rooms only). */
  bookingOf?: (u: Unit) => Booking | null;
  /** "Site / Building / Floor". */
  location: string;
  /** Picklist options by field name, to read a raw option id as its label (fetchModuleFields). */
  options?: Record<string, { value: string; label: string }[]>;
}

/** A time field's value — epoch ms from the record — as a date in the org's own zone. */
export function registerDate(raw: string | undefined): string {
  const ms = Number(raw);
  if (!raw || !Number.isFinite(ms) || ms <= 0) return '';
  const { dateISO } = wallClockInTz(ms, orgTimezone());
  const [y, m, d] = dateISO.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return month ? `${d} ${month} ${y}` : '';
}

/**
 * A picklist value as its label. The API answers with the label or with the raw option id; an id
 * with no option to read it by prints as nothing rather than as a meaningless number.
 */
function picklist(raw: string | undefined, options: { value: string; label: string }[] | undefined): string {
  if (!raw) return '';
  const hit = options?.find((o) => o.value === raw);
  if (hit) return hit.label;
  return /^\d+$/.test(raw) ? '' : raw;
}

/** Whether a row is taken: a room booked in the window, anything else held by someone. */
function taken(u: Unit, ctx: RegisterContext): boolean {
  return ctx.kind === 'room' ? !!ctx.bookingOf?.(u) : !!ctx.holderOf(u);
}

/** One cell, as text — '' for a value the records leave empty. */
export function registerCell(u: Unit, key: string, ctx: RegisterContext): string {
  const kind = ctx.kind ?? 'parking';
  const rec = u.record ?? {};
  const holder = kind === 'room' ? null : ctx.holderOf(u);
  const booking = kind === 'room' ? (ctx.bookingOf?.(u) ?? null) : null;
  switch (key) {
    case 'name':
      return u.label;
    case 'label':
      return ctx.labelField ? (rec[ctx.labelField] ?? '') : '';
    case 'id':
      return rec.id ?? (/^\d+$/.test(u.id) ? u.id : '');
    case 'status':
      if (kind === 'room') return booking ? 'Booked' : 'Free';
      // The record's own state; a space read without its record says what the plan shows.
      return rec.moduleState ?? (holder ? 'Occupied' : 'Vacant');
    case 'loc':
      return ctx.location;
    case 'room':
      return u.room ?? '';
    case 'dtype':
      return u.deskType ? (DESK_TYPE[u.deskType] ?? '') : '';
    case 'ddept':
      return u.department ?? '';
    case 'bookable':
      return u.isReservable === false ? 'No' : 'Yes';
    case 'by':
      return booking ? (ctx.personById(booking.by)?.name ?? '') : '';
    case 'time':
      return booking ? `${fmtTime(booking.start)}–${fmtTime(booking.end)}` : '';
    case 'purpose':
      return booking?.purpose ?? '';
    case 'emp':
      return holder?.name ?? '';
    case 'hrms':
      return holder?.hrmsEmployeeId ?? '';
    case 'dept':
      return holder?.department ?? '';
    case 'desig':
      return holder?.designation ?? '';
    case 'grade':
      return holder?.grade ?? '';
    case 'mobile':
      return holder?.mobile ?? '';
    case 'email':
      return holder?.email ?? '';
    case 'lm':
      return holder?.lineManagerId ? (ctx.personById(holder.lineManagerId)?.name ?? '') : '';
  }
  const field = RECORD_FIELD[kind][key];
  if (!field) return '';
  if (DATE_COLUMNS.has(key)) return registerDate(rec[field]);
  if (PICKLIST_COLUMNS.has(key)) return picklist(rec[field], ctx.options?.[field]);
  return rec[field] ?? '';
}

const byText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const STATUS_ORDER = ['occupied', 'booked', 'vacant', 'free', 'active'];

/** The rows the register lists, filtered and sorted as this print says. */
export function registerRows(units: Unit[], print: RegisterPrint, ctx: RegisterContext): Unit[] {
  const rows = units.filter((u) => print.rows === 'all' || (print.rows === 'assigned' ? taken(u, ctx) : !taken(u, ctx)));
  const label = (u: Unit) => ctx.planLabel(u);
  // Blanks last, whatever the column: a list sorted by department that opens on twenty empty rows
  // hides the ones you were looking for.
  const blanksLast = (a: string, b: string) => (!a === !b ? byText.compare(a, b) : a ? -1 : 1);
  // A room's "person" is who booked it.
  const who = ctx.kind === 'room' ? 'by' : 'emp';
  const cmp: Record<RegisterPrint['sort'], (a: Unit, b: Unit) => number> = {
    name: (a, b) => byText.compare(label(a), label(b)),
    status: (a, b) => {
      const rank = (u: Unit) => {
        const i = STATUS_ORDER.indexOf(registerCell(u, 'status', ctx).toLowerCase());
        return i === -1 ? STATUS_ORDER.length : i;
      };
      return rank(a) - rank(b) || byText.compare(label(a), label(b));
    },
    dept: (a, b) => blanksLast(registerCell(a, 'dept', ctx), registerCell(b, 'dept', ctx)) || byText.compare(label(a), label(b)),
    emp: (a, b) => blanksLast(registerCell(a, who, ctx), registerCell(b, who, ctx)) || byText.compare(label(a), label(b)),
  };
  return [...rows].sort(cmp[print.sort] ?? cmp.name);
}

/**
 * The register's type size and row height for a column count: more columns print smaller so a row
 * still fits the page's width, down to about 6pt at 14 or more.
 */
export function registerType(columns: number): { font: number; row: number } {
  if (columns >= 14) return { font: 8, row: 18 };
  if (columns >= 11) return { font: 9, row: 19 };
  return { font: 10, row: 21 };
}

/**
 * What a register page's table body has for rows: the letter-landscape page less its padding, the
 * bar, the filter line, the two header rows and the footer, with the gaps between them. A row
 * takes its height plus its 1px rule.
 */
const BODY_HEIGHT = 540;

export function rowsPerPage(columns: number): number {
  return Math.floor(BODY_HEIGHT / (registerType(columns).row + 1));
}

/** The rows split into pages. An empty register still prints one page, saying so. */
export function registerPages<T>(rows: T[], perPage: number): T[][] {
  if (!rows.length) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += perPage) pages.push(rows.slice(i, i + perPage));
  return pages;
}

/** How many columns print small enough to call out in the Details window. */
export function columnsNote(columns: number): { text: string; warn: boolean } {
  if (columns >= 14) return { text: `${columns} columns · prints small, about 6pt`, warn: true };
  if (columns >= 11) return { text: `${columns} columns · prints a little smaller`, warn: false };
  return { text: `${columns} columns · fits landscape`, warn: false };
}

/** The registers a plan prints after it, by the plan: desks and rooms on a desk plan, its own kind on another. */
export function registerKindsFor(planId: string): RegisterKind[] {
  if (planId === 'parking') return ['parking'];
  if (planId === 'locker') return ['locker'];
  return ['workstation', 'room'];
}
