import type { Employee, ParkingPrint, Unit } from './types';
import { orgTimezone, wallClockInTz } from './orgTime';

/**
 * The parking register — the pages printed after a parking plan (print window › Details): one row
 * per stall on the plan, a column per detail the person printing ticks. The plan itself has room
 * for a stall's label and one line under it; everything else about a stall is read here.
 *
 * Every value is the org's own: the stall record (Unit.record, read with the floor) and the
 * assigned person's employee record (the roster). Nothing is invented for an empty field — the
 * page prints a dash.
 */

export type RegisterGroup = 'stall' | 'person' | 'dates';

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

/** Where the columns come from: the stall record, the assigned person's employee record, the stall record's dates. */
export const REGISTER_GROUPS: { key: RegisterGroup; label: string }[] = [
  { key: 'stall', label: 'Stall' },
  { key: 'person', label: 'Assigned person' },
  { key: 'dates', label: 'Dates' },
];

/** Every detail the register can carry, in the order it prints them. */
export const REGISTER_COLUMNS: RegisterColumn[] = [
  { key: 'name', group: 'stall', label: 'Stall name', width: 2.2, locked: true },
  { key: 'id', group: 'stall', label: 'Record ID', width: 1 },
  { key: 'qr', group: 'stall', label: 'QR value', width: 2.1 },
  { key: 'type', group: 'stall', label: 'Parking type', head: 'Type', width: 1.25 },
  { key: 'mode', group: 'stall', label: 'Parking mode', head: 'Mode', width: 1.3 },
  { key: 'status', group: 'stall', label: 'Status', width: 1.2 },
  { key: 'area', group: 'stall', label: 'Area', width: 0.6 },
  { key: 'loc', group: 'stall', label: 'Location', width: 2.4 },
  { key: 'emp', group: 'person', label: 'Assigned to', width: 1.7 },
  { key: 'hrms', group: 'person', label: 'HRMS ID', width: 1.25 },
  { key: 'dept', group: 'person', label: 'Department', width: 1.8 },
  { key: 'desig', group: 'person', label: 'Designation', width: 1.4 },
  { key: 'grade', group: 'person', label: 'Grade', width: 0.6 },
  { key: 'mobile', group: 'person', label: 'Mobile', width: 1.75 },
  { key: 'email', group: 'person', label: 'Email', width: 2.2 },
  { key: 'lm', group: 'person', label: 'Line manager', width: 1.6 },
  { key: 'since', group: 'dates', label: 'Occupied since', head: 'Occupied', width: 1.3 },
  { key: 'released', group: 'dates', label: 'Released on', head: 'Released', width: 1.3 },
];

/** The stall record's own field names behind the stall columns (ENEC's parkingstall module). */
const RECORD_FIELD: Record<string, string> = {
  qr: 'qrVal',
  type: 'parkingType',
  mode: 'parkingMode',
  status: 'moduleState',
  area: 'area',
  since: 'occupied_time_parkingstall',
  released: 'released_time_parkingstall',
};
const DATE_COLUMNS = new Set(['since', 'released']);
const PICKLIST_COLUMNS = new Set(['type', 'mode']);

/**
 * The columns this print carries, in register order. When the plan labels stalls by another field
 * (Settings › Parking), that field prints next to the name, always: it is what the reader found on
 * the plan, and the register is where they look it up.
 */
export function registerColumns(print: ParkingPrint, labelField: { name: string; label: string } | null): RegisterColumn[] {
  const chosen = REGISTER_COLUMNS.filter((c) => c.locked || print.cols.includes(c.key));
  if (!labelField || labelField.name === 'name') return chosen;
  const label: RegisterColumn = { key: 'label', group: 'stall', label: labelField.label, width: 1.35, locked: true };
  return [chosen[0], label, ...chosen.slice(1)];
}

export interface RegisterContext {
  /** The plan's label for a stall (see selectors.unitPlanLabel). */
  planLabel: (u: Unit) => string;
  /** The field Settings › Parking labels stalls with, when it is not the name. */
  labelField: string | null;
  holderOf: (u: Unit) => Employee | null;
  personById: (id: string) => Employee | null;
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

/** One cell, as text — '' for a value the records leave empty. */
export function registerCell(u: Unit, key: string, ctx: RegisterContext): string {
  const rec = u.record ?? {};
  const holder = ctx.holderOf(u);
  switch (key) {
    case 'name':
      return u.label;
    case 'label':
      return ctx.labelField ? (rec[ctx.labelField] ?? '') : '';
    case 'id':
      return rec.id ?? (/^\d+$/.test(u.id) ? u.id : '');
    case 'status':
      // The record's own state; a stall read without its record says what the plan shows.
      return rec.moduleState ?? (holder ? 'Occupied' : 'Vacant');
    case 'loc':
      return ctx.location;
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
  const field = RECORD_FIELD[key];
  if (!field) return '';
  if (DATE_COLUMNS.has(key)) return registerDate(rec[field]);
  if (PICKLIST_COLUMNS.has(key)) return picklist(rec[field], ctx.options?.[field]);
  return rec[field] ?? '';
}

const byText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const STATUS_ORDER = ['occupied', 'vacant', 'active'];

/** The stalls the register lists, filtered and sorted as this print says. */
export function registerRows(stalls: Unit[], print: ParkingPrint, ctx: RegisterContext): Unit[] {
  const held = (u: Unit) => !!ctx.holderOf(u);
  const rows = stalls.filter((u) => print.rows === 'all' || (print.rows === 'assigned' ? held(u) : !held(u)));
  const label = (u: Unit) => ctx.planLabel(u);
  // Blanks last, whatever the column: a list sorted by department that opens on twenty empty rows
  // hides the ones you were looking for.
  const blanksLast = (a: string, b: string) => (!a === !b ? byText.compare(a, b) : a ? -1 : 1);
  const cmp: Record<ParkingPrint['sort'], (a: Unit, b: Unit) => number> = {
    name: (a, b) => byText.compare(label(a), label(b)),
    status: (a, b) => {
      const rank = (u: Unit) => {
        const i = STATUS_ORDER.indexOf(registerCell(u, 'status', ctx).toLowerCase());
        return i === -1 ? STATUS_ORDER.length : i;
      };
      return rank(a) - rank(b) || byText.compare(label(a), label(b));
    },
    dept: (a, b) => blanksLast(registerCell(a, 'dept', ctx), registerCell(b, 'dept', ctx)) || byText.compare(label(a), label(b)),
    emp: (a, b) => blanksLast(registerCell(a, 'emp', ctx), registerCell(b, 'emp', ctx)) || byText.compare(label(a), label(b)),
  };
  return [...rows].sort(cmp[print.sort]);
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
