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
import { buildSeatingRows, holderText, seatingColumns, seatingPages, seatingRowLines, seatingSummary } from '../../lib/seatingList';
import type { MeasureText, SeatingColumns } from '../../lib/seatingList';
import { planLabelledDetailAreas } from '../../lib/printAreas';
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
 * The Seating list's geometry. A row is one line (20px) or, when its department or name won't fit
 * its column, two (32px) — decided per row from the text (seatingRowLines), never measured, so
 * the page break can be computed and the viewer, the paper and the PDF break in the same place.
 * 560px is 28 one-line rows: what a letter-landscape page leaves under the bar and over the footer.
 */
const SEATING_COLUMN_PX = 28 * 20;
const SEATING_ROW_PX = { 1: 20, 2: 32 } as const;
/** One of the page's two side-by-side tables: the content width (11in less 34px padding a side) less the 28px gap, halved. */
const SEATING_TABLE_PX = (11 * 96 - 68 - 28) / 2;

/**
 * The plan frame in "Current view": the full content width of the page (11in less the sheet's
 * 34px side padding) by the same 6.2in height. The view is printed at the viewer's OWN zoom —
 * chips, labels and gaps the size they are on screen — so this frame is how much of the floor
 * around the view's centre fits on the page. Height as the whole-floor frame.
 */
const VIEW_FRAME_W = 11 * 96 - 68;
const VIEW_FRAME_H = PRINT_PLAN_HEIGHT_IN * 96;

/**
 * How much larger the detail pages draw chips and labels than the screen does. On screen a label
 * is 8px; on a page that prints at 6pt, which is small for a sheet pinned to a wall. 1.3× prints
 * the holder at ~8pt and the desk name at ~8.3pt. Chips, labels and the gaps between them all
 * scale together, so the collision layout is the screen's own (run at zoom / scale) and the
 * detail areas are cut for a frame 1/scale the size — every label that fits, fits at this size.
 */
const DETAIL_LABEL_SCALE = 1.3;

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
        holderNumber: (id) => contactById(state, state.assignments[id])?.hrmsEmployeeId,
        holderDepartment: (id) => contactById(state, state.assignments[id])?.department,
        colorFor: (u, dept) => departmentColor(u.departmentId || 'name:' + departmentKey(dept), state.departmentColors, planDeptIds),
      },
    );
    // `units`/`booked` are derived from state each render; state is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlan, state]);
  // The employee number gets a column when anyone on the floor has one — the org's names carry it
  // in front ("251850 - …"), and the list prints the name without it.
  const withNumbers = seating.some((r) => r.holderNo);
  const measure = useMemo(listTextMeasure, []);
  const seatCols = seatingColumns(seating, { tablePx: SEATING_TABLE_PX, numbered, withNumbers }, measure);
  const lines = (r: SeatingRow) => seatingRowLines(r, seatCols, measure);
  const seatingPageList = seatingPages(seating, SEATING_COLUMN_PX, 2, (r) => SEATING_ROW_PX[lines(r)]);
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
    const markers = planMarkers(state);
    const desks = markers
      .filter((m) => m.type === 'workstation' && m.geom.kind === 'point')
      .map((m) => ({ id: m.id, x: (m.geom as { x: number }).x * IMG_W, y: (m.geom as { y: number }).y * IMG_H }));
    // A detail page shows every desk in FULL — its name, who holds it, their department — checked
    // with the same label layout the page draws with (PrintZoomedPlan); an area where one doesn't
    // fit is zoomed in further (see planLabelledDetailAreas).
    const inputs = markerLabelInputs(state, markers, { personal: false });
    const wants = new Map(inputs.map((i) => [i.id, i]));
    const allLabelled = (area: DetailArea) => {
      const placed = planMarkerLabels(inputs, { planW: IMG_W, planH: IMG_H, zoom: area.zoom / DETAIL_LABEL_SCALE });
      return area.deskIds.every((id) => {
        const p = placed.get(id);
        const want = wants.get(id);
        return !!p?.name && (!want?.sub || p.sub) && (!want?.dept || !!p.dept);
      });
    };
    return planLabelledDetailAreas(desks, { frameW: VIEW_FRAME_W, frameH: VIEW_FRAME_H, labelScale: DETAIL_LABEL_SCALE, allLabelled });
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
          cols={seatCols}
          lines={lines}
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
  cols,
  lines,
}: {
  columns: SeatingRow[][];
  where: Where;
  /** The plan page shows desk numbers (Whole floor), so the list carries them too. */
  numbered: boolean;
  /** Column widths in px, sized to the floor's rows; `empNo` 0 when nobody has an employee number. */
  cols: SeatingColumns;
  /** How many lines each row takes — decided once, with the page breaks. */
  lines: (r: SeatingRow) => 1 | 2;
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
              {numbered && <col style={{ width: cols.no }} />}
              <col style={{ width: cols.desk }} />
              <col style={{ width: cols.holder }} />
              {cols.empNo > 0 && <col style={{ width: cols.empNo }} />}
              <col style={{ width: cols.dept }} />
            </colgroup>
            {columns[c] && (
              <>
                <thead>
                  <tr>
                    {numbered && <th>#</th>}
                    <th>Desk</th>
                    <th>Assigned to</th>
                    {cols.empNo > 0 && <th>Emp no</th>}
                    <th>Department</th>
                  </tr>
                </thead>
                <tbody>
                  {columns[c].map((r) => (
                    <tr key={r.id} className={lines(r) === 2 ? styles.rowTwo : undefined}>
                      {numbered && (
                        <td className={styles.cellNo}>
                          <span className={styles.noChip} style={chipColors.get(r.id)}>
                            {r.no}
                          </span>
                        </td>
                      )}
                      <td className={styles.cellDesk}>
                        <span className={styles.cellText}>{r.desk}</span>
                      </td>
                      <td className={r.status === 'assigned' ? styles.cellHolder : styles.cellQuiet}>
                        <span className={styles.cellText}>{holderText(r)}</span>
                      </td>
                      {cols.empNo > 0 && <td className={styles.cellEmpNo}>{r.holderNo ?? ''}</td>}
                      <td className={styles.cellDept}>
                        {r.department ? (
                          <span className={styles.cellText}>
                            <span className={styles.deptDot} style={{ background: r.departmentColor }} />
                            {r.department}
                          </span>
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

/**
 * The Seating list's text widths, measured in the page's own font on a canvas — what decides the
 * column widths and which rows need a second line. A 3% margin covers the difference between the
 * canvas and the page's text layout. No canvas (tests, SSR): the character-count estimate.
 */
function listTextMeasure(): MeasureText | undefined {
  if (typeof document === 'undefined') return undefined;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return undefined;
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif';
  return (text, bold) => {
    ctx.font = `${bold ? 600 : 400} 11px ${family}`;
    return Math.ceil(ctx.measureText(text).width * 1.03);
  };
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
function PrintZoomedPlan({ cx, cy, zoom, labelScale = 1 }: { cx: number; cy: number; zoom: number; labelScale?: number }) {
  const { state } = useFloorplan();
  const rooms = planRooms(state);
  const markers = planMarkers(state);
  // Chips and labels `labelScale`× their screen size: laid out as the screen would at
  // zoom / labelScale (same geometry, everything divided by the scale), drawn at labelScale / zoom.
  const labelPlan = useMemo(
    () => planMarkerLabels(markerLabelInputs(state, markers, { personal: false }), { planW: IMG_W, planH: IMG_H, zoom: zoom / labelScale }),
    // Built once per page, from the state at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, labelScale],
  );
  const invZ = labelScale / zoom;
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
        <Marker key={m.id} unit={m} invZ={invZ} personal={false} labels={labelPlan.get(m.id)} />
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
          <PrintZoomedPlan cx={area.cx} cy={area.cy} zoom={area.zoom} labelScale={DETAIL_LABEL_SCALE} />
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
    () => planMarkerLabels(markerLabelInputs(state, markers, { personal: false }), { planW: IMG_W, planH: IMG_H, zoom: PRINT_ZOOM }),
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
          <Marker key={m.id} unit={m} invZ={invZ} personal={false} badge={String(no)} />
        ) : (
          <Marker key={m.id} unit={m} invZ={invZ} personal={false} labels={labelPlan.get(m.id)} />
        );
      })}
    </div>
  );
}

