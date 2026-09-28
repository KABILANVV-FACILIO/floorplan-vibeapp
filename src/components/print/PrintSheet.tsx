import { useEffect, useMemo, useState } from 'react';
import type { Ref } from 'react';
import { flushSync } from 'react-dom';
import { useFloorplan } from '../../state/FloorplanContext';
import { bookedUnitIds, contactById, floorMeta, isAssignable, markerLabelInputs, planMarkers, planRooms, visibleUnits } from '../../state/selectors';
import { markerStyle } from '../../lib/unitStatus';
import { floorImageKey, unitOnPlan } from '../../lib/types';
import type { Unit, UnitType } from '../../lib/types';
import { orgNow } from '../../lib/orgTime';
import { IMG_H, IMG_W } from '../../lib/mockData';
import { planMarkerLabels } from '../../lib/labelLayout';
import { FloorplanBackground } from '../canvas/FloorplanBackground';
import { RoomPolygon } from '../canvas/RoomPolygon';
import { RoomLabel } from '../canvas/Canvas';
import { Marker } from '../canvas/Marker';
import { legendItems } from '../canvas/Legend';
import { departmentColor, departmentKey, departmentsIn } from '../../lib/departmentColors';
import { buildSeatingRows, seatingPages, seatingSummary } from '../../lib/seatingList';
import type { SeatingRow } from '../../lib/seatingList';
import styles from './PrintSheet.module.css';

/**
 * The plan frame's printed height, and the zoom it implies. Fixed in physical units because the
 * sheet is `display: none` on screen and cannot be measured before it prints — and the zoom has
 * to be known exactly, since it decides which labels fit (see planMarkerLabels). 5.4in is what
 * letter landscape leaves once the title block, legend and footer are counted.
 */
const PRINT_PLAN_HEIGHT_IN = 5.4;
const PRINT_ZOOM = (PRINT_PLAN_HEIGHT_IN * 96) / IMG_H;

/**
 * Seating list rows per column. Every cell is one line, clipped with an ellipsis, so a row is
 * always exactly SEATING_ROW_PX tall and the page break can be computed rather than measured —
 * which is what keeps the viewer, the paper and the PDF breaking in the same place. 28 rows of
 * 20px leave room for the title block and the footer on a letter-landscape page.
 */
const SEATING_ROWS_PER_COLUMN = 28;

/**
 * The floor plan print sheet — a port of `Floorplan Print.dc.html` from the Claude Design project
 * "Copy of Floorplan Canvas Architecture": a landscape letter page carrying the floor's title
 * block, a stat card per module, the occupancy legend, the plan itself, and a footer.
 *
 * Two things the design could only mock, and this cannot:
 *
 *   - OCCUPANCY. The design hashed each unit id to a coin flip. Here it is what the sheet's own
 *     footer promises — "assignments and confirmed bookings" — so a unit counts as occupied when
 *     the org says someone holds it, or a booking covers the window currently on screen. It is
 *     deliberately NOT `unitStatus`, which answers a different question per mode (a desk reads
 *     "Not bookable" in Booking view); a printed sheet must say the same thing whichever tab
 *     happened to be open when it was printed.
 *   - WHICH UNITS. The design placed a fixed demo grid. Here it is exactly what the canvas draws:
 *     the enabled modules, on this plan, with a position — so the paper and the screen cannot
 *     disagree about what is on the floor.
 *
 * Rendered always, shown only on paper (see the module CSS), so Cmd+P produces the sheet without
 * going near the toolbar button. The toolbar button opens the print viewer instead, which draws
 * the same page on screen (`preview`) with Print and Download PDF beside it.
 *
 * THE PLAN is drawn the way the viewer draws it, by the viewer's own components — the real image,
 * room outlines, the same marker chips and the same labels — rather than a washed-out picture with
 * a dot per unit. The design this was ported from drew it as a separate, simpler picture, and the
 * result was a sheet that did not look like the floor anyone had just been looking at. It is the
 * whole floor fitted to the page: the plane at its native 1492×1054, scaled down exactly the way
 * the viewer scales it, so every chip and label lands where it does on screen.
 *
 * SEATING LIST pages follow the plan. The plan labels a desk only where its labels fit, so on a
 * dense floor most desks print without a name, a holder or a department. The list carries all
 * three for EVERY desk — the plan says where, the list says who.
 */

/** The modules the sheet reports, in the design's order. Amenities carry no occupancy. */
const CARD_TYPES: { type: UnitType; name: string }[] = [
  { type: 'workstation', name: 'Desks' },
  { type: 'room', name: 'Rooms' },
  { type: 'locker', name: 'Lockers' },
  { type: 'parking', name: 'Parking' },
];

export function PrintSheet({ preview = false, pagesRef }: { preview?: boolean; pagesRef?: Ref<HTMLDivElement> } = {}) {
  const { state } = useFloorplan();
  const meta = floorMeta(state, state.floorId);
  const booked = bookedUnitIds(state);

  // What the occupancy figures count: the plan's own units, less amenities, which hold no one.
  const units = visibleUnits(state).filter(
    (u) => u.type !== 'amenity' && !u.unplaced && unitOnPlan(u, state.planId) && (u.geom.kind === 'point' || u.geom.pts.length > 0),
  );

  // The plan is built only while printing. Every Marker reads the whole shared app state, so a
  // permanently mounted second copy would re-render on every pan and zoom frame of the viewer for
  // a page nobody is printing. `beforeprint` fires for Cmd+P as well as the toolbar button, and
  // flushSync makes the plan exist before the browser lays the page out.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  const isOccupied = (u: Unit) => !!state.assignments[u.id] || booked.has(u.id);

  const total = units.length;
  const occupied = units.filter(isOccupied).length;

  const cards = CARD_TYPES.map(({ type, name }) => {
    const list = units.filter((u) => u.type === type);
    const occ = list.filter(isOccupied).length;
    return { type, name, total: list.length, available: list.length - occ, pct: list.length ? Math.round((occ / list.length) * 100) : 0 };
  }).filter((c) => c.total > 0);

  const floorTitle = meta ? meta.floor.name : 'Floor plan';
  const siteLine = meta ? `${meta.site.name} · ${meta.building.name}` : '';
  const now = orgNow();
  const generatedAt = new Date(`${now.dateISO}T${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`).toLocaleString(
    undefined,
    { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
  // The viewer draws the page on screen and needs the plan in it from the start; the paper copy
  // waits for `beforeprint` (above).
  const showPlan = preview || printing;

  // Every desk on the plan, with who is placed there and their department — built only when the
  // sheet is actually shown, for the same reason as the plan (see `printing` above).
  const seating = useMemo(() => {
    if (!showPlan) return [];
    const planDeptIds = departmentsIn(state.units).map((d) => d.id);
    return buildSeatingRows(
      units.filter((u) => u.type === 'workstation'),
      {
        holderName: (id) => {
          const holder = state.assignments[id];
          return holder ? (contactById(state, holder)?.name ?? '') : null;
        },
        isBooked: (id) => booked.has(id),
        isAssignable,
        holderDepartment: (id) => contactById(state, state.assignments[id])?.department,
        colorFor: (u, dept) => departmentColor(u.departmentId || 'name:' + departmentKey(dept), state.departmentColors, planDeptIds),
      },
    );
    // `units`/`booked` are derived from state each render; state is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlan, state]);
  const seatingPageList = seatingPages(seating, SEATING_ROWS_PER_COLUMN);
  // Each desk's number in the list, printed on its chip on the plan: the plan says where desk 12
  // is, the list says who sits at 12. Only desks are numbered — lockers and parking keep theirs.
  const deskNumbers = useMemo(() => new Map(seating.map((r) => [r.id, r.no])), [seating]);
  // The number chip in the list is drawn exactly like the desk's chip on the plan — same function,
  // same state — so "4" looks the same in both places, whatever the desk's status or colour mode.
  const chipColors = useMemo(() => {
    const m = new Map<string, { background: string; borderColor: string; color: string }>();
    for (const u of units) {
      if (!deskNumbers.has(u.id)) continue;
      const st = markerStyle(state, u);
      m.set(u.id, { background: st.bg, borderColor: st.bd, color: st.fg });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deskNumbers, state]);
  const pageCount = 1 + seatingPageList.length;

  const planPage = (
    <div className={styles.page} data-print-page="">
      <div className={styles.head}>
        <div className={styles.headLeft}>
          {/* No wordmark and no "Seat occupancy" eyebrow: this sheet is printed inside the
              organisation that owns the floor, on their paper, and branding the vendor on it
              tells the reader nothing they need. The floor's own name leads instead. */}
          <div className={styles.title}>{floorTitle}</div>
          {siteLine && <div className={styles.siteLine}>{siteLine}</div>}
        </div>
        <div className={styles.headRight}>
          <div className={styles.generatedAt}>{generatedAt}</div>
          <div className={styles.cards}>
            {cards.map((c) => (
              <div key={c.type} className={styles.card}>
                <span className={styles.cardName}>{c.name}</span>
                <div className={styles.cardFigures}>
                  <span className={styles.cardBig}>{c.available}</span>
                  <span className={styles.cardOf}>free of {c.total}</span>
                </div>
                <div className={styles.cardBar}>
                  <div className={styles.cardBarFill} style={{ width: `${c.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.legend}>
        {/* The viewer's own key — the colours on this plan mean what they meant on screen. */}
        {legendItems(state).map((it) => (
          <span key={it.label} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: it.color }} />
            {it.label}
          </span>
        ))}
        <span className={styles.spacer} />
        <span className={styles.totalLine}>
          {occupied} of {total} units occupied
        </span>
      </div>

      <div className={styles.planWrap}>
        <div className={styles.plan}>{showPlan && <PrintPlan deskNumbers={deskNumbers} />}</div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>Occupancy reflects assignments and confirmed bookings at the time of printing.</span>
        {pageCount > 1 && <span className={styles.pageNo}>Page 1 of {pageCount} · each desk's number is its row in the Seating list that follows</span>}
      </div>
    </div>
  );

  const pages = (
    <>
      {planPage}
      {seatingPageList.map((columns, i) => (
        <SeatingPage
          key={i}
          columns={columns}
          floorTitle={floorTitle}
          siteLine={siteLine}
          generatedAt={generatedAt}
          pageNo={i + 2}
          pageCount={pageCount}
          summary={seatingSummary(seating)}
          chipColors={chipColors}
        />
      ))}
    </>
  );

  return preview ? (
    <div ref={pagesRef} className={styles.previewPages}>
      {pages}
    </div>
  ) : (
    <div className={styles.sheet}>{pages}</div>
  );
}

/**
 * One Seating list page: the floor's name, then every desk in two side-by-side columns — desk,
 * who is placed there, department (with the colour its desks have on the plan).
 */
function SeatingPage({
  columns,
  floorTitle,
  siteLine,
  generatedAt,
  pageNo,
  pageCount,
  summary,
  chipColors,
}: {
  columns: SeatingRow[][];
  chipColors: Map<string, { background: string; borderColor: string; color: string }>;
  floorTitle: string;
  siteLine: string;
  generatedAt: string;
  pageNo: number;
  pageCount: number;
  summary: string;
}) {
  return (
    <div className={styles.page} data-print-page="">
      <div className={styles.head}>
        <div className={styles.headLeft}>
          <div className={styles.title}>
            {floorTitle} <span className={styles.titleSub}>· Seating list</span>
          </div>
          {siteLine && <div className={styles.siteLine}>{siteLine}</div>}
        </div>
        <div className={styles.headRight}>
          <div className={styles.generatedAt}>{generatedAt}</div>
        </div>
      </div>

      <div className={styles.seatCols}>
        {[0, 1].map((c) => (
          <table key={c} className={styles.seatTable}>
            <colgroup>
              <col className={styles.colNo} />
              <col className={styles.colDesk} />
              <col className={styles.colHolder} />
              <col className={styles.colDept} />
            </colgroup>
            {columns[c] && (
              <>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Desk</th>
                    <th>Assigned to</th>
                    <th>Department</th>
                  </tr>
                </thead>
                <tbody>
                  {columns[c].map((r) => (
                    <tr key={r.id}>
                      <td className={styles.cellNo}>
                        <span className={styles.noChip} style={chipColors.get(r.id)}>
                          {r.no}
                        </span>
                      </td>
                      <td className={styles.cellDesk}>{r.desk}</td>
                      <td className={r.status === 'assigned' ? styles.cellHolder : styles.cellQuiet}>
                        {r.status === 'assigned'
                          ? r.holder ?? 'Assigned'
                          : r.status === 'booked'
                            ? 'Booked'
                            : r.status === 'unassignable'
                              ? 'Not assignable'
                              : 'Free'}
                      </td>
                      <td className={styles.cellDept}>
                        {r.department ? (
                          <>
                            <span className={styles.deptDot} style={{ background: r.departmentColor }} />
                            {r.department}
                          </>
                        ) : (
                          <span className={styles.cellQuiet}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        ))}
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>{summary}. Desks are listed by name; the number is the one on the desk's chip on the plan (page 1).</span>
        <span className={styles.pageNo}>
          Page {pageNo} of {pageCount}
        </span>
      </div>
    </div>
  );
}

/** What a downloaded sheet is called: the floor and the day it was drawn, safe as a file name. */
export function printFileName(floorTitle: string, dateISO: string): string {
  const safe = floorTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'Floor plan';
  return `${safe} ${dateISO}.pdf`;
}

/**
 * The floor as the viewer draws it, at the print zoom. Same components, same rules, same label
 * layout — only the zoom is fixed (PRINT_ZOOM) instead of wherever the user left it.
 */
function PrintPlan({ deskNumbers }: { deskNumbers: Map<string, number> }) {
  const { state } = useFloorplan();
  const rooms = planRooms(state);
  const markers = planMarkers(state);
  const labelPlan = useMemo(
    () => planMarkerLabels(markerLabelInputs(state, markers), { planW: IMG_W, planH: IMG_H, zoom: PRINT_ZOOM }),
    // Built once per print, from the state at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const invZ = 1 / PRINT_ZOOM;

  return (
    <div
      className={styles.plane}
      style={{ width: IMG_W, height: IMG_H, transform: `scale(${PRINT_ZOOM})`, ['--inv' as string]: invZ }}
    >
      <FloorplanBackground imageUrl={state.floorImages[floorImageKey(state.floorId, state.planId)]} />
      {rooms.map((r) => (
        <RoomPolygon key={r.id} unit={r} />
      ))}
      {rooms.map((r) => (
        <RoomLabel key={`l-${r.id}`} unit={r} />
      ))}
      {markers.map((m) => {
        // A numbered desk carries no text labels: its name, holder and department are on its row
        // in the Seating list, so the plan stays readable however dense the floor is.
        const no = deskNumbers.get(m.id);
        return no ? (
          <Marker key={m.id} unit={m} invZ={invZ} badge={String(no)} />
        ) : (
          <Marker key={m.id} unit={m} invZ={invZ} labels={labelPlan.get(m.id)} />
        );
      })}
    </div>
  );
}

