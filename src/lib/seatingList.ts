import type { Unit } from './types';

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
  /** Who is placed at the desk; null when free or booked, or when the holder isn't in the roster. */
  holder: string | null;
  department: string | null;
  departmentColor?: string;
}

export interface SeatingLookups {
  /** The assigned employee's name, or '' when the desk is assigned to someone not in the roster. */
  holderName: (unitId: string) => string | null;
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
        holder: name ? name : null,
        department,
        departmentColor: department ? look.colorFor(u, department) : undefined,
      };
    })
    .sort((a, b) => a.desk.localeCompare(b.desk, undefined, { numeric: true, sensitivity: 'base' }))
    .map((r, i) => ({ ...r, no: i + 1 }));
}

/**
 * Rows laid out as pages of side-by-side columns: each page is `columns` columns of up to
 * `rowsPerColumn` rows, filled column by column (down the left, then down the right), the way a
 * printed directory reads; a page that isn't full is split evenly across its columns. Chunked
 * here rather than with CSS columns so the viewer, the paper and the PDF can't disagree about
 * where a page breaks.
 */
export function seatingPages<T>(rows: T[], rowsPerColumn: number, columns = 2): T[][][] {
  const perPage = Math.max(1, rowsPerColumn) * Math.max(1, columns);
  const pages: T[][][] = [];
  for (let start = 0; start < rows.length; start += perPage) {
    const pageRows = rows.slice(start, start + perPage);
    // A page that isn't full (a small floor, or the last page) splits evenly across the columns
    // rather than piling into the left one and leaving half the sheet blank.
    const perColumn = Math.min(rowsPerColumn, Math.ceil(pageRows.length / columns));
    const cols: T[][] = [];
    for (let c = 0; c < columns; c++) {
      const col = pageRows.slice(c * perColumn, (c + 1) * perColumn);
      if (col.length) cols.push(col);
    }
    pages.push(cols);
  }
  return pages;
}

export function seatingSummary(rows: SeatingRow[]): string {
  const n = (s: SeatStatus) => rows.filter((r) => r.status === s).length;
  const parts = [`${rows.length} ${rows.length === 1 ? 'desk' : 'desks'}`, `${n('assigned')} assigned`];
  if (n('booked')) parts.push(`${n('booked')} booked`);
  parts.push(`${n('free')} free`);
  if (n('unassignable')) parts.push(`${n('unassignable')} not assignable`);
  return parts.join(' · ');
}
