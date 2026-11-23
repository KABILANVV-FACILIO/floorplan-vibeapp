import { useEffect, useMemo, useRef, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { activeDepartments, colorByOf, deskDepartmentCounts, floorCounts } from '../../state/selectors';
import type { CountedType, FloorCount } from '../../state/selectors';
import { departmentsIn } from '../../lib/departmentColors';
import { moduleColor } from '../../lib/unitStatus';
import { fmtTime } from '../../lib/geometry';
import { parseISO } from '../primitives/Calendar';
import styles from './FloorCounts.module.css';

const NAME: Record<CountedType, string> = { workstation: 'Desks', parking: 'Parking', room: 'Rooms' };
/** Each type's three tiles: who holds it, what is set aside, what is left — desks and stalls in their records' own words. */
const TILES: Record<CountedType, [string, string, string]> = {
  workstation: ['Occupied', 'Temporarily vacant', 'Vacant'],
  parking: ['Occupied', 'Reserved', 'Vacant'],
  room: ['Occupied', 'Booked', 'Free'],
};
/** How many departments the card lists before "Show all": the largest ones, by desks. */
const TOP_DEPARTMENTS = 5;
/** The switch's pick, kept per browser: it is the viewer's own, never the org's. */
const COLOUR_KEY = 'fp.floorCounts.colorBy';
/** How long the card lingers after the pointer leaves, so it can cross the gap from the chip. */
const HOVER_CLOSE_MS = 180;

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
    // A blocked store costs only the memory of the pick.
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
 * The floor's occupancy, as a chip in the plan's top bar (Assignment and Booking views): one line —
 * "Desks 91/122 · Rooms 0/18", taken of all per type — that covers no desk at any zoom. Hovering it
 * opens the card under it; a click keeps the card open until a second click, Escape or a click
 * elsewhere. (A floating card over the plan hid desks; in the Location panel it was out of sight.)
 *
 * The card: every desk, parking stall and room placed on the floor (selectors.floorCounts), in the
 * state colours set in Settings. Each type reads as its name, how many in all and how much is taken
 * (all but the last tile), then three tiles, each edged in its colour with the figure over what it
 * counts: desks Occupied · Temporarily vacant · Vacant and stalls Occupied · Reserved · Vacant, the
 * middle one their records' own state (desks and stalls are not booked in this org); rooms Occupied ·
 * Booked (in the date and hours picked in the toolbar, said under the title) · Free. A zero is a
 * dash, and a room — never held — shows Occupied as one. Ticked departments narrow desks and stalls;
 * rooms stay whole-floor.
 *
 * In Assignment view a switch colours the desks by department for this viewer (colorByView, never
 * saved for the org; Settings › Desks › Colour desks by stays the default for everyone): the plan,
 * the legend and the desks bar then take each department's colour. The pick is remembered in this
 * browser.
 */
export function FloorCounts() {
  const { state, actions } = useFloorplanData();
  // Shown while hovered; pinned by a click.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!pinned) return;
    const close = () => {
      setPinned(false);
      setHovered(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);
  // The viewer's last pick, back on load.
  useEffect(() => {
    const kept = readColour();
    if (kept) actions.setColorByView(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Counted only when what they read changes — the stage re-renders on every pan and zoom frame.
  const { units, assignments, recordStates, bookings, date, start, end, spaceDepartments, enabledModules, departmentColors, employees, colorByView, colorBy, mode } = state;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => floorCounts(state), [units, assignments, recordStates, bookings, date, start, end, spaceDepartments, enabledModules, employees]);
  const freeDesk = moduleColor(state, 'workstation', 'free');
  const deptLines = useMemo(
    () => (mode === 'assign' && colorByOf(state) === 'department' ? deskDepartmentCounts(state, freeDesk) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [units, assignments, spaceDepartments, enabledModules, employees, departmentColors, colorByView, colorBy, mode, freeDesk],
  );
  if (!rows.length || (mode !== 'assign' && mode !== 'book')) return null;

  const partsOf = (row: FloorCount): Part[] => {
    const [held, aside, rest] = TILES[row.type];
    const parts: Part[] = [
      { key: 'occupied', label: held, n: row.occupied, color: moduleColor(state, row.type, 'assigned') },
      { key: 'aside', label: aside, n: row.aside, color: moduleColor(state, row.type, row.type === 'workstation' ? 'tempVacant' : 'booked') },
      { key: 'free', label: rest, n: row.free, color: moduleColor(state, row.type, row.type === 'room' ? 'available' : 'free') },
    ];
    return row.type === 'room' ? parts.slice(1) : parts;
  };
  // The window under the title is what the Rooms row's Booked counts; nothing else reads it.
  const hasRooms = rows.some((r) => r.type === 'room');
  // The switch: Assignment view only (Booking view asks what is free, which a team colour can't
  // say), and only where a desk on the floor carries a department to colour by.
  const canColourByDept = state.mode === 'assign' && rows.some((r) => r.type === 'workstation') && departmentsIn(state.units).length > 0;
  const byDept = canColourByDept && colorByOf(state) === 'department';
  const departments = activeDepartments(state);
  const day = parseISO(date)?.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) ?? date;
  const open = hovered || pinned;

  return (
    <div
      ref={wrapRef}
      className={styles.chipWrap}
      onMouseEnter={() => {
        window.clearTimeout(closeTimer.current);
        setHovered(true);
      }}
      onMouseLeave={() => {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setHovered(false), HOVER_CLOSE_MS);
      }}
    >
      <button
        type="button"
        className={[styles.chip, open ? styles.chipOn : ''].join(' ')}
        aria-expanded={open}
        // What the chip shows, said: "Occupancy: Desks 95 of 122, Rooms 1 of 18".
        aria-label={`Occupancy: ${rows.map((row) => `${NAME[row.type]} ${row.total - row.free} of ${row.total}`).join(', ')}`}
        onClick={() => {
          setPinned((p) => !p);
          setHovered(!pinned);
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </svg>
        {/* Taken (all but vacant or free) of all, per type — the card says the rest. */}
        {rows.map((row, i) => (
          <span key={row.type} className={styles.chipPart}>
            {i > 0 && <span className={styles.chipSep}>·</span>}
            {NAME[row.type]} <b>{row.total - row.free}</b>/{row.total}
          </span>
        ))}
        <svg className={styles.chipCaret} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <section className={styles.card} aria-label="Occupancy of this floor">
          <div className={styles.head}>
            <div className={styles.headText}>
              <div className={styles.title}>Occupancy</div>
              {hasRooms && (
                <div className={styles.sub}>
                  Room bookings for {day}, {fmtTime(start)}–{fmtTime(end)}
                </div>
              )}
            </div>
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
            const taken = Math.round(((row.total - row.free) / row.total) * 100);
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
                      <dt className={styles.tileLabel}>{p.label}</dt>
                      <dd className={[styles.tileValue, p.n ? '' : styles.tileNone].join(' ')}>{p.n || '–'}</dd>
                    </div>
                  ))}
                </dl>
                {lines && <ByDepartment lines={lines} total={row.total} />}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
