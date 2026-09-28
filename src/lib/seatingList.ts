import type { Unit } from './types';
import { departmentDisplayName, personCode, personDisplayName } from './displayNames';

/**
 * The print sheet's Seating list: every desk on the floor, with who is placed there and their
 * department — the part of the floor a plan can't carry once desks sit closer than three lines of
 * text. The plan page shows WHERE; these pages show WHO, for every desk, without exception.
 *
 * Pure (no state, no React), so pagination is pinned by tests: the demo floor is too small to show
 * a second list page, and an ENEC floor is not.
 */

/** `unassignable`: a desk that is booked, never assigned (a hot desk) — "Not assignable", as in the viewer. */
export type SeatStatus = 'assigned' | 'booked' | 'free' | 'unassignable';

export interface SeatingRow {
  id: string;
  /** 1-based, in list order — printed on the desk's chip on the plan, so the two can be matched. */
  no: number;
  desk: string;
  status: SeatStatus;
  /** Who is placed at the desk, as a person reads it (no employee number); null when free or booked, or when the holder isn't in the roster. */
  holder: string | null;
  /** The holder's employee number — printed in its own column rather than in front of the name. */
  holderNo: string | null;
  /** The department as a person reads it, without a cost-centre code in front. */
  department: string | null;
  departmentColor?: string;
}

export interface SeatingLookups {
  /** The assigned employee's name as the record has it, or '' when the desk is assigned to someone not in the roster. */
  holderName: (unitId: string) => string | null;
  /** The holder's HRMS id, when the org fills it; otherwise the number in front of their name is used. */
  holderNumber?: (unitId: string) => string | null | undefined;
  isBooked: (unitId: string) => boolean;
  isAssignable: (unit: Unit) => boolean;
  /** The holder's own department, used only when the desk carries none. */
  holderDepartment: (unitId: string) => string | undefined;
  colorFor: (unit: Unit, department: string) => string | undefined;
}

export function buildSeatingRows(desks: Unit[], look: SeatingLookups): SeatingRow[] {
  return desks
    .map((u): Omit<SeatingRow, 'no'> => {
      const name = look.holderName(u.id);
      const status: SeatStatus =
        name !== null ? 'assigned' : look.isBooked(u.id) ? 'booked' : look.isAssignable(u) ? 'free' : 'unassignable';
      // The desk's department first — it is what colours the desk on the plan, and a desk can be
      // lent to someone from another team. The holder's own department only fills a gap.
      const department = u.department?.trim() || (status === 'assigned' ? look.holderDepartment(u.id)?.trim() : undefined) || null;
      return {
        id: u.id,
        desk: u.label,
        status,
        holder: name ? personDisplayName(name) : null,
        holderNo: name ? look.holderNumber?.(u.id)?.trim() || personCode(name) : null,
        department: department ? departmentDisplayName(department) : null,
        // The colour is looked up by the record's own department, not the name shown.
        departmentColor: department ? look.colorFor(u, department) : undefined,
      };
    })
    .sort((a, b) => a.desk.localeCompare(b.desk, undefined, { numeric: true, sensitivity: 'base' }))
    .map((r, i) => ({ ...r, no: i + 1 }));
}

/**
 * Rows laid out as pages of side-by-side columns: each page is `columns` columns holding up to
 * `columnHeight` of rows, filled column by column (down the left, then down the right), the way a
 * printed directory reads; a page that isn't full is split evenly across its columns. Chunked
 * here rather than with CSS columns so the viewer, the paper and the PDF can't disagree about
 * where a page breaks.
 *
 * `heightOf` is each row's height in the same units as `columnHeight` — 1 per row by default, so
 * `columnHeight` is then simply rows per column. The printed list passes pixels: a row whose
 * department needs two lines is taller, and the page holds fewer of them.
 */
export function seatingPages<T>(rows: T[], columnHeight: number, columns = 2, heightOf: (row: T) => number = () => 1): T[][][] {
  const cap = Math.max(1, columnHeight);
  const nCols = Math.max(1, columns);
  const h = (r: T) => Math.max(0, heightOf(r));

  // Fill one column from `from`: rows while they fit, and always at least one (a row taller than
  // a whole column still has to print somewhere).
  const fill = (from: number, limit: number): number => {
    let used = 0;
    let i = from;
    while (i < rows.length && (i === from || used + h(rows[i]) <= limit)) used += h(rows[i++]);
    return i;
  };

  const pages: T[][][] = [];
  let start = 0;
  while (start < rows.length) {
    const cols: T[][] = [];
    let i = start;
    for (let c = 0; c < nCols && i < rows.length; c++) {
      const next = fill(i, cap);
      cols.push(rows.slice(i, next));
      i = next;
    }
    // A page that isn't full (a small floor, or the last page) splits evenly across the columns
    // rather than piling into the left one and leaving half the sheet blank.
    if (i >= rows.length && nCols > 1) {
      const pageRows = rows.slice(start, i);
      const target = pageRows.reduce((sum, r) => sum + h(r), 0) / nCols;
      const balanced: T[][] = [];
      let j = 0;
      for (let c = 0; c < nCols && j < pageRows.length; c++) {
        const col: T[] = [];
        let used = 0;
        const last = c === nCols - 1;
        while (j < pageRows.length && (last || col.length === 0 || used + h(pageRows[j]) / 2 <= target)) {
          used += h(pageRows[j]);
          col.push(pageRows[j++]);
        }
        balanced.push(col);
      }
      const fits = balanced.every((col) => col.length === 1 || col.reduce((sum, r) => sum + h(r), 0) <= cap);
      pages.push(fits ? balanced.filter((col) => col.length) : cols);
    } else {
      pages.push(cols);
    }
    start = i;
  }
  return pages;
}

/** What the "Assigned to" cell reads: the holder, or the desk's status when nobody is placed there. */
export function holderText(r: Pick<SeatingRow, 'status' | 'holder'>): string {
  if (r.status === 'assigned') return r.holder ?? 'Assigned';
  if (r.status === 'booked') return 'Booked';
  if (r.status === 'unassignable') return 'Not assignable';
  return 'Free';
}

/**
 * Column widths for the printed list, in px, sized to what the floor's rows actually hold.
 *
 * Fixed percentages gave every floor the same columns, and the department — the longest text in
 * a row and the one people scan — the leftover 30%: "Project Implementati…". A demo floor's desks
 * are called "New Test Desk 1" and an ENEC floor's "E-1-WS77", so the desk column is as wide as
 * its longest name (within limits), the holder column likewise, and the department takes the rest.
 * Widths are estimated from character counts (the same ~0.55em advance the plan's labels use);
 * a cell that still doesn't fit wraps to a second line (`seatingRowLines`) rather than clipping.
 */
export interface SeatingColumns {
  no: number;
  desk: number;
  holder: number;
  /** 0 when the list has no employee-number column. */
  empNo: number;
  dept: number;
}

/**
 * The width of a cell's text in px at the list's 11px type (bold for desk names). The print sheet
 * passes a canvas measurement in the page's own font; tests and anything without a canvas use
 * this estimate, ~0.57em a character — a touch generous, so an estimate errs toward a second line
 * rather than a clipped one.
 */
export type MeasureText = (text: string, bold?: boolean) => number;
export const estimateText: MeasureText = (text, bold) => Math.ceil(text.length * 11 * 0.57 * (bold ? 1.06 : 1));

const CELL_PAD = 16;
/** The department's colour dot and its gap. */
const DEPT_DOT = 14;
const clampPx = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function seatingColumns(
  rows: SeatingRow[],
  opts: { tablePx: number; numbered: boolean; withNumbers: boolean },
  measure: MeasureText = estimateText,
): SeatingColumns {
  const widths = (f: (r: SeatingRow) => string | null | undefined, bold = false) =>
    rows
      .map(f)
      .filter((t): t is string => !!t)
      .map((t) => measure(t, bold))
      .sort((a, b) => a - b);
  const max = (w: number[]) => (w.length ? w[w.length - 1] : 0);
  // The width 90% of the column's cells fit in: one very long name wraps rather than taking the
  // department's room on every row of the list.
  const p90 = (w: number[]) => (w.length ? w[Math.min(w.length - 1, Math.floor(w.length * 0.9))] : 0);

  const no = opts.numbered ? 40 : 0;
  const empNo = opts.withNumbers ? clampPx(max(widths((r) => r.holderNo)) + CELL_PAD, 60, 90) : 0;
  const desk = clampPx(max(widths((r) => r.desk, true)) + CELL_PAD, 60, 150);
  const room = opts.tablePx - no - empNo - desk;
  const holderWant = clampPx(p90(widths(holderText)) + CELL_PAD, 90, 220);
  const deptWant = Math.max(120, p90(widths((r) => r.department)) + DEPT_DOT + CELL_PAD);
  let holder = holderWant;
  if (holderWant + deptWant > room) {
    // Not enough for both: share what there is in proportion, each keeping enough that its long
    // entries fit in two lines ("Abdulrahman Abdullah / Khalaf AlAnazi", "Chief Communications &
    // PR / Officer Office") — the holder at least 140, the department at least 150.
    const HOLDER_MIN = Math.min(140, holderWant);
    holder = Math.max(HOLDER_MIN, Math.min(room - 150, Math.round((room * holderWant) / (holderWant + deptWant))));
  }
  return { no, desk, holder, empNo, dept: Math.max(0, room - holder) };
}

/** 1, or 2 when the row's desk, holder or department won't fit its column on one line. */
export function seatingRowLines(r: SeatingRow, cols: SeatingColumns, measure: MeasureText = estimateText): 1 | 2 {
  if (measure(r.desk, true) > cols.desk - CELL_PAD) return 2;
  if (measure(holderText(r)) > cols.holder - CELL_PAD) return 2;
  if (r.department && measure(r.department) + DEPT_DOT > cols.dept - CELL_PAD) return 2;
  return 1;
}

export function seatingSummary(rows: SeatingRow[]): string {
  const n = (s: SeatStatus) => rows.filter((r) => r.status === s).length;
  const parts = [`${rows.length} ${rows.length === 1 ? 'desk' : 'desks'}`, `${n('assigned')} assigned`];
  if (n('booked')) parts.push(`${n('booked')} booked`);
  parts.push(`${n('free')} free`);
  if (n('unassignable')) parts.push(`${n('unassignable')} not assignable`);
  return parts.join(' · ');
}
