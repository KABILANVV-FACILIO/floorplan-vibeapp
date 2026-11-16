import { useEffect, useMemo, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { activeDepartments, colorByOf, deskDepartmentCounts, floorCounts } from '../../state/selectors';
import type { CountedType, FloorCount } from '../../state/selectors';
import { departmentsIn } from '../../lib/departmentColors';
import { moduleColor } from '../../lib/unitStatus';
import { fmtTime } from '../../lib/geometry';
import { parseISO } from '../primitives/Calendar';
import styles from './FloorCounts.module.css';

const NAME: Record<CountedType, string> = { workstation: 'Desks', parking: 'Parking', room: 'Rooms' };
const LABEL: Record<string, string> = { occupied: 'Occupied', booked: 'Booked', free: 'Free' };
/** How many departments the card lists before "Show all": the largest ones, by desks. */
const TOP_DEPARTMENTS = 5;
const FOLD_KEY = 'fp.floorCounts.folded';
/** The switch's pick, kept per browser like the fold: it is the viewer's own, never the org's. */
const COLOUR_KEY = 'fp.floorCounts.colorBy';

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}
function writeFolded(folded: boolean) {
  try {
    localStorage.setItem(FOLD_KEY, folded ? '1' : '0');
  } catch {
    // A blocked store costs only the memory of the fold.
  }
}
function readColour(): 'status' | 'department' | null {
  try {
    const v = localStorage.getItem(COLOUR_KEY);
    return v === 'status' || v === 'department' ? v : null;
  } catch {
    return null;
  }
}
function writeColour(value: 'status' | 'department') {
  try {
    localStorage.setItem(COLOUR_KEY, value);
  } catch {
    // As above: only the memory of the pick is lost.
  }
}

interface Part {
  key: string;
  label: string;
  n: number;
  color: string;
}

type DeptLine = ReturnType<typeof deskDepartmentCounts>[number];

/**
 * Coloured by department, under the desks' tiles: each department's share in a bar, then the
 * largest few by desks — with how many of theirs are occupied — and the rest a click away. A floor
 * of fifteen departments would otherwise run the card off the screen; "No department" is last.
 */
function ByDepartment({ lines, total }: { lines: DeptLine[]; total: number }) {
  const [all, setAll] = useState(false);
  const named = lines.filter((d) => d.id).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const none = lines.find((d) => !d.id);
  const shown = all ? named : named.slice(0, TOP_DEPARTMENTS);
  const hidden = named.length - shown.length;
  return (
    <div className={styles.byDept}>
      <div className={styles.byDeptHead}>
        <span>By department</span>
        <span>{named.length} {named.length === 1 ? 'department' : 'departments'}</span>
      </div>
      <div className={styles.bar} aria-hidden>
        {[...named, ...(none ? [none] : [])].map((d) => (d.total ? <span key={d.id || 'none'} style={{ width: `${(d.total / total) * 100}%`, background: d.color }} /> : null))}
      </div>
      <ul className={[styles.deptLines, all ? styles.deptLinesAll : ''].join(' ')}>
        {[...shown, ...(none && (all || !hidden) ? [none] : [])].map((d) => (
          <li key={d.id || 'none'} className={styles.deptLine}>
            <span className={styles.swatch} style={{ background: d.color }} />
            <span className={styles.deptName} title={d.name}>
              {d.name}
            </span>
            <span className={styles.deptOcc}>{d.occupied} occupied</span>
            <b className={styles.deptTotal}>{d.total}</b>
          </li>
        ))}
      </ul>
      {(hidden > 0 || all) && named.length > TOP_DEPARTMENTS && (
        <button type="button" className={styles.moreBtn} aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${named.length} departments${none ? ' and No department' : ''}`}
        </button>
      )}
    </div>
  );
}

/**
 * The floor's occupancy, in the Location panel under "Spaces on this floor" (Assignment and Booking
 * views) — not over the plan, where a card hid desks at every zoom. Every desk, parking stall
 * and room placed on the floor, and how many are occupied, booked in the date and hours picked in
 * the toolbar, and free (selectors.floorCounts) — in the state colours set in Settings. Each type
 * reads as its name, how many in all and how much is taken, then three tiles (Occupied, Booked,
 * Free), each edged in its state colour with the figure over what it counts; a zero is a dash, and
 * a room — never held — shows Occupied as one. Ticked departments narrow desks and stalls; rooms
 * stay whole-floor.
 *
 * In Assignment view a switch colours the desks by department for this viewer (colorByView, never
 * saved for the org; Settings › Desks › Colour desks by stays the default for everyone): the plan,
 * the legend and the desks bar then take each department's colour. The pick and the fold are
 * remembered in this browser.
 */
export function FloorCounts() {
  const { state, actions } = useFloorplanData();
  const [folded, setFolded] = useState(readFolded);
  // The viewer's last pick, back on load.
  useEffect(() => {
    const kept = readColour();
    if (kept) actions.setColorByView(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Counted only when what they read changes — the stage re-renders on every pan and zoom frame.
  const { units, assignments, bookings, date, start, end, spaceDepartments, enabledModules, departmentColors, employees, colorByView, colorBy, mode } = state;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => floorCounts(state), [units, assignments, bookings, date, start, end, spaceDepartments, enabledModules, employees]);
  const freeDesk = moduleColor(state, 'workstation', 'free');
  const deptLines = useMemo(
    () => (mode === 'assign' && colorByOf(state) === 'department' ? deskDepartmentCounts(state, freeDesk) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [units, assignments, spaceDepartments, enabledModules, employees, departmentColors, colorByView, colorBy, mode, freeDesk],
  );
  if (!rows.length || (mode !== 'assign' && mode !== 'book')) return null;

  const fold = (value: boolean) => {
    setFolded(value);
    writeFolded(value);
  };
  const partsOf = (row: FloorCount): Part[] => {
    const parts: Part[] = [
      { key: 'occupied', label: 'occupied', n: row.occupied, color: moduleColor(state, row.type, 'assigned') },
      { key: 'booked', label: 'booked', n: row.booked, color: moduleColor(state, row.type, 'booked') },
      { key: 'free', label: 'free', n: row.free, color: moduleColor(state, row.type, row.type === 'room' ? 'available' : 'free') },
    ];
    return row.type === 'room' ? parts.slice(1) : parts;
  };
  // The switch: Assignment view only (Booking view asks what is free, which a team colour can't
  // say), and only where a desk on the floor carries a department to colour by.
  const canColourByDept = state.mode === 'assign' && rows.some((r) => r.type === 'workstation') && departmentsIn(state.units).length > 0;
  const byDept = canColourByDept && colorByOf(state) === 'department';
  const departments = activeDepartments(state);
  const day = parseISO(date)?.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) ?? date;
  const lead = rows[0];

  if (folded) {
    return (
      <button type="button" className={styles.pill} aria-expanded={false} aria-label="Show the occupancy of this floor" onClick={() => fold(false)}>
        <span className={styles.pillTitle}>Occupancy</span>
        {/* One line in the panel: the lead type's taken of all — the tiles say the rest. */}
        <span className={styles.pillPart}>
          <b>{lead.occupied + lead.booked}</b>/{lead.total} {NAME[lead.type].toLowerCase()} taken
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    );
  }

  return (
    <section className={styles.card} aria-label="Occupancy of this floor">
      <div className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.title}>Occupancy</div>
          <div className={styles.sub}>
            Bookings for {day}, {fmtTime(start)}–{fmtTime(end)}
          </div>
        </div>
        <button type="button" className={styles.foldBtn} aria-expanded aria-label="Fold the occupancy" data-tip="Fold" onClick={() => fold(true)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
      </div>

      {canColourByDept && (
        <div className={styles.switchRow}>
          <span className={styles.switchLabel}>Colour by</span>
          <div className={styles.switch} role="group" aria-label="Colour desks by" data-tip="For you only — Settings › Desks sets it for everyone">
            {(['status', 'department'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={[styles.switchBtn, (byDept ? 'department' : 'status') === v ? styles.switchOn : ''].join(' ')}
                aria-pressed={(byDept ? 'department' : 'status') === v}
                onClick={() => {
                  actions.setColorByView(v);
                  writeColour(v);
                }}
              >
                {v === 'status' ? 'Status' : 'Department'}
              </button>
            ))}
          </div>
        </div>
      )}

      {rows.map((row) => {
        const lines = byDept && row.type === 'workstation' ? deptLines : null;
        const parts = partsOf(row);
        // The card counts the whole floor, whichever plan is on screen ("On this floor"); the one
        // row that needs a word is Rooms under ticked departments, which it does not narrow.
        const hint = row.type === 'room' && departments.length ? 'whole floor' : '';
        const taken = Math.round(((row.occupied + row.booked) / row.total) * 100);
        return (
          <div key={row.type} className={styles.row}>
            <div className={styles.rowHead}>
              <span className={styles.rowName}>{NAME[row.type]}</span>
              {hint && <span className={styles.rowHint}>{hint}</span>}
              <span className={styles.rowMeta}>
                {row.total} in all · {taken}% taken
              </span>
            </div>
            <dl className={styles.tiles}>
              {/* A room is never held: its Occupied tile is a dash, so the tiles line up with the others'. */}
              {row.type === 'room' && (
                <div className={[styles.tile, styles.tileUnused].join(' ')}>
                  <dt className={styles.tileLabel}>Occupied</dt>
                  <dd className={[styles.tileValue, styles.tileNone].join(' ')}>–</dd>
                </div>
              )}
              {parts.map((p) => (
                <div key={p.key} className={styles.tile} style={{ borderTopColor: p.color }}>
                  <dt className={styles.tileLabel}>{LABEL[p.key]}</dt>
                  <dd className={[styles.tileValue, p.n ? '' : styles.tileNone].join(' ')}>{p.n || '–'}</dd>
                </div>
              ))}
            </dl>
            {lines && <ByDepartment lines={lines} total={row.total} />}
          </div>
        );
      })}
    </section>
  );
}
