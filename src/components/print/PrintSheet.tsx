import { useEffect, useMemo, useState } from 'react';
import type { Ref } from 'react';
import { flushSync } from 'react-dom';
import { useFloorplan } from '../../state/FloorplanContext';
import { bookedUnitIds, contactById, floorMeta, isAssignable, markerLabelInputs, planMarkers, planRooms, visibleUnits } from '../../state/selectors';
import { markerStyle } from '../../lib/unitStatus';
import { floorImageKey, unitOnPlan } from '../../lib/types';
import type { Unit } from '../../lib/types';
import type { AppState } from '../../state/types';
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
import { planDetailAreas } from '../../lib/printAreas';
import type { DetailArea } from '../../lib/printAreas';
import type { SeatingRow } from '../../lib/seatingList';
import styles from './PrintSheet.module.css';

/**
 * The plan frame's printed height, and the zoom it implies. Fixed in physical units because the
 * sheet is `display: none` on screen and cannot be measured before it prints — and the zoom has
 * to be known exactly, since it decides which labels fit (see planMarkerLabels). 6.2in is what
 * letter landscape leaves once the bar, legend and footer are counted.
 */
const PRINT_PLAN_HEIGHT_IN = 6.2;
const PRINT_ZOOM = (PRINT_PLAN_HEIGHT_IN * 96) / IMG_H;

/**
 * Seating list rows per column. Every cell is one line, clipped with an ellipsis, so a row is
 * always exactly SEATING_ROW_PX tall and the page break can be computed rather than measured —
 * which is what keeps the viewer, the paper and the PDF breaking in the same place. 28 rows of
 * 20px leave room for the title block and the footer on a letter-landscape page.
 */
const SEATING_ROWS_PER_COLUMN = 28;

/**
 * The plan frame in "Current view": the full content width of the page (11in less the sheet's
 * 34px side padding) by the same 6.2in height. The view is printed at the viewer's OWN zoom —
 * chips, labels and gaps the size they are on screen — so this frame is how much of the floor
 * around the view's centre fits on the page. Height as the whole-floor frame.
 */
const VIEW_FRAME_W = 11 * 96 - 68;
const VIEW_FRAME_H = PRINT_PLAN_HEIGHT_IN * 96;

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

  // The bar's figures: the floor's DESKS — what the Seating list lists — occupied meaning someone
  // is assigned or a booking covers the window on screen. A floor with no desks counts its other
  // units instead, so the bar never reads "Total 0" above a plan full of lockers.
  const desks = units.filter((u) => u.type === 'workstation');
  const counted = desks.length ? desks : units;
  const total = counted.length;
  const occupied = counted.filter(isOccupied).length;
  const vacant = total - occupied;

  const floorTitle = meta ? meta.floor.name : 'Floor plan';
  const where = { site: meta?.site.name ?? '', building: meta?.building.name ?? '', floor: floorTitle };
  const now = orgNow();
  const generatedAt = new Date(`${now.dateISO}T${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`).toLocaleString(
    undefined,
    { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
  // The viewer draws the page on screen and needs the plan in it from the start; the paper copy
  // waits for `beforeprint` (above).
  const showPlan = preview || printing;
  // "Current view" needs a view to print; before the canvas has measured itself there is none.
  const scope: AppState['printScope'] =
    state.printScope === 'view' ? (state.stage.w > 0 && state.stage.h > 0 ? 'view' : 'floor') : state.printScope;
  // The whole-floor page numbers its desks, keyed to the Seating list; the on-screen view doesn't.
  const numbered = scope !== 'view';

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
  // "Floor + details": every area of desks on a page of its own, zoomed so each desk carries its
  // name above and "Holder · Department" below (see lib/printAreas).
  const detailAreas = useMemo(() => {
    if (!showPlan || scope !== 'detail') return [];
    const desks = planMarkers(state)
      .filter((m) => m.type === 'workstation' && m.geom.kind === 'point')
      .map((m) => ({ id: m.id, x: (m.geom as { x: number }).x * IMG_W, y: (m.geom as { y: number }).y * IMG_H }));
    return planDetailAreas(desks, { frameW: VIEW_FRAME_W, frameH: VIEW_FRAME_H });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlan, scope, state]);
  const pageCount = 1 + detailAreas.length + seatingPageList.length;

  const planPage = (
    <div className={styles.page} data-print-page="">
      {/* One bar: where this is, and how full. No wordmark and no eyebrow — this sheet is printed
          inside the organisation that owns the floor, and the floor's own name leads. */}
      <div className={styles.bar}>
        <LocationBox where={where} />
        <span className={styles.spacer} />
        <span className={styles.statPlain}>
          Total <b>{total}</b>
        </span>
        <span className={[styles.stat, styles.statOccupied].join(' ')}>
          Occupied <b>{occupied}</b>
        </span>
        <span className={[styles.stat, styles.statVacant].join(' ')}>
          Vacant <b>{vacant}</b>
        </span>
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
        <span className={styles.totalLine}>Printed {generatedAt}</span>
      </div>

      <div className={styles.planWrap}>
        <div className={[styles.plan, scope === 'view' ? styles.planView : ''].join(' ')}>
          {showPlan && (scope === 'view' ? <PrintViewPlan /> : <PrintPlan deskNumbers={deskNumbers} />)}
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>Occupancy reflects assignments and confirmed bookings at the time of printing.</span>
        {pageCount > 1 && (
          <span className={styles.pageNo}>
            Page 1 of {pageCount} ·{' '}
            {scope === 'detail'
              ? "each desk's number is its row in the Seating list; zoomed-in pages of every area follow"
              : numbered
                ? "each desk's number is its row in the Seating list that follows"
                : 'the area on screen when printed; every desk is listed on the pages that follow'}
          </span>
        )}
      </div>
    </div>
  );

  const pages = (
    <>
      {planPage}
      {detailAreas.map((area, i) => (
        <DetailPage
          key={`d${i}`}
          area={area}
          index={i}
          count={detailAreas.length}
          where={where}
          generatedAt={generatedAt}
          pageNo={i + 2}
          pageCount={pageCount}
        />
      ))}
      {seatingPageList.map((columns, i) => (
        <SeatingPage
          key={i}
          columns={columns}
          where={where}
          generatedAt={generatedAt}
          pageNo={1 + detailAreas.length + i + 1}
          pageCount={pageCount}
          summary={seatingSummary(seating)}
          chipColors={chipColors}
          numbered={numbered}
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
  where,
  generatedAt,
  pageNo,
  pageCount,
  summary,
  chipColors,
  numbered,
}: {
  columns: SeatingRow[][];
  where: Where;
  /** The plan page shows desk numbers (Whole floor), so the list carries them too. */
  numbered: boolean;
  chipColors: Map<string, { background: string; borderColor: string; color: string }>;
  generatedAt: string;
  pageNo: number;
  pageCount: number;
  summary: string;
}) {
  return (
    <div className={styles.page} data-print-page="">
      <div className={styles.bar}>
        <LocationBox where={where} />
        <span className={styles.barLabel}>Seating list</span>
        <span className={styles.spacer} />
        <span className={styles.totalLine}>Printed {generatedAt}</span>
      </div>

      <div className={styles.seatCols}>
        {[0, 1].map((c) => (
          <table key={c} className={styles.seatTable}>
            <colgroup>
              {numbered && <col className={styles.colNo} />}
              <col className={numbered ? styles.colDesk : styles.colDeskWide} />
              <col className={styles.colHolder} />
              <col className={styles.colDept} />
            </colgroup>
            {columns[c] && (
              <>
                <thead>
                  <tr>
                    {numbered && <th>#</th>}
                    <th>Desk</th>
                    <th>Assigned to</th>
                    <th>Department</th>
                  </tr>
                </thead>
                <tbody>
                  {columns[c].map((r) => (
                    <tr key={r.id}>
                      {numbered && (
                        <td className={styles.cellNo}>
                          <span className={styles.noChip} style={chipColors.get(r.id)}>
                            {r.no}
                          </span>
                        </td>
                      )}
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
        <span className={styles.footNote}>
          {summary}. Desks are listed by name{numbered ? "; the number is the one on the desk's chip on the plan (page 1)" : ''}.
        </span>
        <span className={styles.pageNo}>
          Page {pageNo} of {pageCount}
        </span>
      </div>
    </div>
  );
}

interface Where {
  site: string;
  building: string;
  floor: string;
}

/** "HQ - Abu Dhabi / C Block / 06 Floor": the site in bold, the rest of the path after it. */
function LocationBox({ where }: { where: Where }) {
  const rest = [where.building, where.floor].filter(Boolean).join(' / ');
  return (
    <div className={styles.where}>
      {where.site ? (
        <>
          <b>{where.site}</b>
          {rest && <span className={styles.wherePath}> / {rest}</span>}
        </>
      ) : (
        <b>{where.floor}</b>
      )}
    </div>
  );
}

/** What a downloaded sheet is called: the floor and the day it was drawn, safe as a file name. */
export function printFileName(floorTitle: string, dateISO: string): string {
  const safe = floorTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'Floor plan';
  return `${safe} ${dateISO}.pdf`;
}

/**
 * "Current view": the plan exactly as the viewer draws it right now — the viewer's own zoom, the
 * same label layout (so the desk names above and "Holder · Department" below land as they do on
 * screen) — centred on what the screen is centred on, and cropped to the page's plan frame.
 *
 * At the viewer's zoom rather than scaled to fit: shrinking the screen onto paper would shrink
 * its 8.5px labels past legibility. Same zoom means same-size text and the same labels shown.
 */
function PrintViewPlan() {
  const { state } = useFloorplan();
  const { tx, ty, z } = state.view;
  // The plan point at the centre of the screen.
  return <PrintZoomedPlan cx={(state.stage.w / 2 - tx) / z} cy={(state.stage.h / 2 - ty) / z} zoom={z} />;
}

/**
 * The plan at a given zoom, centred on a given plan point, cropped to the page's plan frame — the
 * viewer's own components and label layout, so desk names above and "Holder · Department" below
 * land exactly as the viewer places them at that zoom. Used by "Current view" and the detail pages.
 */
function PrintZoomedPlan({ cx, cy, zoom }: { cx: number; cy: number; zoom: number }) {
  const { state } = useFloorplan();
  const rooms = planRooms(state);
  const markers = planMarkers(state);
  const labelPlan = useMemo(
    () => planMarkerLabels(markerLabelInputs(state, markers), { planW: IMG_W, planH: IMG_H, zoom }),
    // Built once per page, from the state at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom],
  );
  const invZ = 1 / zoom;
  const ox = VIEW_FRAME_W / 2 - cx * zoom;
  const oy = VIEW_FRAME_H / 2 - cy * zoom;

  return (
    <div
      className={styles.plane}
      style={{ width: IMG_W, height: IMG_H, transform: `translate(${ox}px, ${oy}px) scale(${zoom})`, ['--inv' as string]: invZ }}
    >
      <FloorplanBackground imageUrl={state.floorImages[floorImageKey(state.floorId, state.planId)]} />
      {rooms.map((r) => (
        <RoomPolygon key={r.id} unit={r} />
      ))}
      {rooms.map((r) => (
        <RoomLabel key={`l-${r.id}`} unit={r} />
      ))}
      {markers.map((m) => (
        <Marker key={m.id} unit={m} invZ={invZ} labels={labelPlan.get(m.id)} />
      ))}
    </div>
  );
}

/**
 * One detail page: an area of the floor zoomed so every desk in it is labelled, under the same bar
 * as page 1. The desks shown are that area's; its neighbours at the edge are drawn too, for context,
 * and have pages of their own.
 */
function DetailPage({
  area,
  index,
  count,
  where,
  generatedAt,
  pageNo,
  pageCount,
}: {
  area: DetailArea;
  index: number;
  count: number;
  where: Where;
  generatedAt: string;
  pageNo: number;
  pageCount: number;
}) {
  const { state } = useFloorplan();
  return (
    <div className={styles.page} data-print-page="">
      <div className={styles.bar}>
        <LocationBox where={where} />
        <span className={styles.barLabel}>
          Detail {index + 1} of {count}
        </span>
        <span className={styles.spacer} />
        <span className={styles.statPlain}>
          Desks <b>{area.deskIds.length}</b>
        </span>
      </div>

      <div className={styles.legend}>
        {legendItems(state).map((it) => (
          <span key={it.label} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: it.color }} />
            {it.label}
          </span>
        ))}
        <span className={styles.spacer} />
        <span className={styles.totalLine}>Printed {generatedAt}</span>
      </div>

      <div className={styles.planWrap}>
        <div className={[styles.plan, styles.planView].join(' ')}>
          <PrintZoomedPlan cx={area.cx} cy={area.cy} zoom={area.zoom} />
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>Every desk in this area, with who is placed there. The whole floor is on page 1.</span>
        <span className={styles.pageNo}>
          Page {pageNo} of {pageCount}
        </span>
      </div>
    </div>
  );
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

