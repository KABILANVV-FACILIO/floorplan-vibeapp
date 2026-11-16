import { useEffect, useMemo, useState } from 'react';
import type { Ref } from 'react';
import { flushSync } from 'react-dom';
import { useFloorplan } from '../../state/FloorplanContext';
import { activeDepartments, bookedUnitIds, floorMeta, markerLabelInputs, planMarkers, planRooms, roomLabelInputs, unitDepartment } from '../../state/selectors';
import { floorImageKey } from '../../lib/types';
import type { RegisterKind, Unit } from '../../lib/types';
import type { AppState } from '../../state/types';
import { IMG_H, IMG_W } from '../../lib/mockData';
import { CHIP_FOOTPRINT_OF_PITCH, CHIP_PX, chipScreenSize, planMarkerLabels, planRoomLabels, typographyOf } from '../../lib/labelLayout';
import { FloorplanBackground } from '../canvas/FloorplanBackground';
import { RoomPolygon } from '../canvas/RoomPolygon';
import { RoomLabel } from '../canvas/Canvas';
import { Marker } from '../canvas/Marker';
import { markerModel } from '../../lib/markerModel';
import { sharedLabelTextMeasurer } from '../../lib/textMeasure';
import { departmentNames, legendItems, LegendSwatch } from '../canvas/Legend';
import { ResponderNoticePage } from './ResponderNoticePage';
import { respondersOnFloor } from '../../lib/firstResponders';
import { deskPitch, planLabelledDetailAreas } from '../../lib/printAreas';
import type { DetailArea } from '../../lib/printAreas';
import { REGISTERS, registerCell, registerColumns, registerKindsFor, registerPages, registerRows, registerType, rowsPerPage } from '../../lib/register';
import type { RegisterColumn, RegisterContext } from '../../lib/register';
import { fmtTime } from '../../lib/geometry';
import { parseISO } from '../primitives/Calendar';
import { printableUnits, useRegister } from './useRegister';
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
 * A big floor prints its cards a notch smaller (~7pt) rather than a notch more pages: a 400-desk
 * floor needs 20 pages at 1.3× and 16 at this. Used only past DETAIL_PAGES_COMFORTABLE.
 */
const DETAIL_LABEL_SCALE_SMALL = 1.15;
const DETAIL_PAGES_COMFORTABLE = 12;

/** The spaces a detail page is cut for: the ones a person holds — whichever the plan on page 1 draws. */
const DETAIL_TYPES = new Set<Unit['type']>(['workstation', 'parking', 'locker']);
/** How a detail page names them, by the plan printed: one, and a heading for the count. */
const DETAIL_NOUN: Record<string, [string, string]> = { workstation: ['desk', 'Desks'], custom: ['desk', 'Desks'], parking: ['stall', 'Stalls'], locker: ['locker', 'Lockers'] };

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
 * "Floor + details" follows the whole floor with a DETAIL page per area of desks, zoomed so every
 * desk on it carries its name, who holds it and their department.
 */

export function PrintSheet({ preview = false, pagesRef }: { preview?: boolean; pagesRef?: Ref<HTMLDivElement> } = {}) {
  const { state } = useFloorplan();
  const meta = floorMeta(state, state.floorId);
  const booked = bookedUnitIds(state);

  // What the occupancy figures count: the plan's own units, less amenities, which hold no one.
  const units = printableUnits(state);

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
  // The departments ticked on screen (the Spaces panel): the print is theirs, as the screen is —
  // the other departments' spaces faded and unlabelled, and the counts, the detail pages and the
  // parking register theirs only. None ticked is every department.
  const departments = activeDepartments(state);
  const inDepartments = (u: Unit) => !departments.length || departments.includes(unitDepartment(state, u) ?? '');

  // The bar's figures: the floor's DESKS, occupied meaning someone
  // is assigned or a booking covers the window on screen. A floor with no desks counts its other
  // units instead, so the bar never reads "Total 0" above a plan full of lockers.
  const desks = units.filter((u) => u.type === 'workstation');
  const counted = (desks.length ? desks : units).filter(inDepartments);
  const total = counted.length;
  const occupied = counted.filter(isOccupied).length;
  const vacant = total - occupied;

  const floorTitle = meta ? meta.floor.name : 'Floor plan';
  const where = { site: meta?.site.name ?? '', building: meta?.building.name ?? '', floor: floorTitle };
  // The viewer draws the page on screen and needs the plan in it from the start; the paper copy
  // waits for `beforeprint` (above).
  const showPlan = preview || printing;
  // "Current view" needs a view to print; before the canvas has measured itself there is none.
  const scope: AppState['printScope'] =
    state.printScope === 'view' ? (state.stage.w > 0 && state.stage.h > 0 ? 'view' : 'floor') : state.printScope;

  // "Floor + details": every area of the plan's own spaces — desks, or the stalls of a parking plan,
  // or the lockers of a locker plan — on a page of its own, zoomed so each carries its name above,
  // and its holder and their department below (see lib/printAreas). A car park's stalls sit too
  // close for their holders to fit on the whole floor; these pages are where they all print.
  const detailAreas = useMemo(() => {
    if (!showPlan || scope !== 'detail') return [];
    const markers = planMarkers(state);
    // Only the ticked departments' spaces get pages (any department when none is ticked).
    const desks = markers
      .filter((m) => DETAIL_TYPES.has(m.type) && m.geom.kind === 'point' && inDepartments(m))
      .map((m) => ({ id: m.id, x: (m.geom as { x: number }).x * IMG_W, y: (m.geom as { y: number }).y * IMG_H }));
    // A detail page shows every desk in FULL — its name, who holds it, their department — checked
    // with the same label layout the page draws with (PrintZoomedPlan); an area where one doesn't
    // fit is zoomed in further (see planLabelledDetailAreas).
    const inputs = markerLabelInputs(state, markers, { personal: false, departments, keepSelected: false, measure: sharedLabelTextMeasurer() });
    const roomInputs = roomLabelInputs(state, planRooms(state), { measure: sharedLabelTextMeasurer() });
    const typography = typographyOf(state.labelStyle);
    // The page is planned exactly as it is drawn: chips first, then the room names clear of them,
    // then the cards clear of both (see PrintZoomedPlan).
    const chipBoxesAt = (z: number) => inputs.map((i) => ({ x: i.x * IMG_W * z - i.size / 2, y: i.y * IMG_H * z - i.size / 2, w: i.size, h: i.size }));
    const planAt = (labelScale: number) => {
      const labelledAt = (zoom: number) => {
        const z = zoom / labelScale;
        const roomBoxes = [...planRoomLabels(roomInputs, { planW: IMG_W, planH: IMG_H, zoom: z, reserved: chipBoxesAt(z) }).values()].map((p) => p.box);
        const placed = planMarkerLabels(inputs, { planW: IMG_W, planH: IMG_H, zoom: z, typography, reserved: roomBoxes });
        const done = new Set<string>();
        for (const want of inputs) {
          const p = placed.get(want.id);
          if (!!p?.name && (!want.sub || p.sub) && (!want.dept || !!p.dept)) done.add(want.id);
        }
        return done;
      };
      return planLabelledDetailAreas(desks, { frameW: VIEW_FRAME_W, frameH: VIEW_FRAME_H, labelScale, labelledAt }).map((a) => ({ ...a, labelScale }));
    };
    const areas = planAt(DETAIL_LABEL_SCALE);
    return areas.length > DETAIL_PAGES_COMFORTABLE ? planAt(DETAIL_LABEL_SCALE_SMALL) : areas;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlan, scope, state]);
  // The registers after the plan (see lib/register): desks and rooms after a desk plan, its own kind
  // after a parking or locker plan — each when print › Details has it on, with the details it asks
  // for. Every kind is read always (hooks), but a kind's field list only when its plan prints.
  const regs: Record<RegisterKind, ReturnType<typeof useRegister>> = {
    workstation: useRegister(state, 'workstation'),
    room: useRegister(state, 'room'),
    parking: useRegister(state, 'parking'),
    locker: useRegister(state, 'locker'),
  };
  const registers = useMemo(() => {
    if (!showPlan) return [];
    let before = 0;
    return registerKindsFor(state.planId).flatMap((kind) => {
      const print = state.printRegisters[kind];
      const data = regs[kind];
      // A kind the plan has none of prints nothing; parking prints its page even empty, as it did.
      if (!print.register || (!data.units.length && kind !== 'parking')) return [];
      const cols = registerColumns(print, data.labelField, kind);
      const rows = registerRows(data.units, print, data.ctx);
      const pages = registerPages(rows, rowsPerPage(cols.length));
      const reg = { kind, cols, total: rows.length, pages, ctx: data.ctx, first: before };
      before += pages.length;
      return [reg];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPlan, state.planId, state.printRegisters, regs.workstation, regs.room, regs.parking, regs.locker]);
  const registerCount = registers.reduce((n, r) => n + r.pages.length, 0);
  // A room register says the window its bookings are for — the date and hours picked in the toolbar.
  const bookingWindow = `${parseISO(state.date)?.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) ?? state.date}, ${fmtTime(state.start)}–${fmtTime(state.end)}`;
  // The floor's emergency-contacts notice, last — only when someone on this floor is named.
  const hasNotice = respondersOnFloor(state).length > 0;
  const pageCount = 1 + detailAreas.length + registerCount + (hasNotice ? 1 : 0);

  const planPage = (
    <div className={styles.page} data-print-page="">
      {/* One bar: where this is, and how full. No wordmark and no eyebrow — this sheet is printed
          inside the organisation that owns the floor, and the floor's own name leads. */}
      <div className={styles.bar}>
        <LocationBox where={where} />
        <DepartmentsBox departments={departments} />
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
            {it.glyph ? <LegendSwatch item={it} size={7} /> : <span className={styles.legendDot} style={{ background: it.color }} />}
            {it.label}
          </span>
        ))}
        <FadedLegendItem departments={departments} />
      </div>

      <div className={styles.planWrap}>
        <div className={[styles.plan, scope === 'view' ? styles.planView : ''].join(' ')}>
          {showPlan && (scope === 'view' ? <PrintViewPlan /> : <PrintPlan />)}
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>
          {departments.length > 0 && `Printed for ${departmentNames(departments)}: other departments’ spaces are faded and unlabelled, and the counts are theirs only. `}
          Occupancy reflects assignments and confirmed bookings at the time of printing.
        </span>
        {pageCount > 1 && (
          <span className={styles.pageNo}>
            Page 1 of {pageCount}
            {detailAreas.length ? (departments.length ? ' · zoomed-in pages of their areas follow' : ' · zoomed-in pages of every area follow') : ''}
            {registers.length === 1 ? ` · the ${REGISTERS[registers[0].kind].title.toLowerCase()} follows` : registers.length ? ' · registers follow' : ''}
            {hasNotice ? ' · first responders on the last page' : ''}
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
          pageNo={i + 2}
          pageCount={pageCount}
        />
      ))}
      {registers.map((reg) =>
        reg.pages.map((rows, i) => (
          <RegisterPage
            key={`r-${reg.kind}-${i}`}
            kind={reg.kind}
            rows={rows}
            cols={reg.cols}
            ctx={reg.ctx}
            index={i}
            count={reg.pages.length}
            total={reg.total}
            print={state.printRegisters[reg.kind]}
            departments={reg.kind === 'room' ? [] : departments}
            bookingWindow={bookingWindow}
            where={where}
            pageNo={1 + detailAreas.length + reg.first + i + 1}
            pageCount={pageCount}
          />
        )),
      )}
      {hasNotice && <ResponderNoticePage where={where} pageNo={pageCount} pageCount={pageCount} header={<LocationBox where={where} />} />}
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

interface Where {
  site: string;
  building: string;
  floor: string;
}

/**
 * The floor's name, large and in full — it is what the sheet is of — with the site and building
 * under it in smaller type. One line of path in a 60%-wide box used to end in "Test Flo…", the
 * floor being the part cut off.
 */
/** The departments a page was printed for — beside the floor's name, so nobody reads it as the whole floor. */
function DepartmentsBox({ departments }: { departments: string[] }) {
  if (!departments.length) return null;
  return (
    <div className={styles.depts}>
      <div className={styles.deptsLabel}>{departments.length === 1 ? 'Department' : 'Departments'}</div>
      <div className={styles.deptsNames}>{departmentNames(departments)}</div>
    </div>
  );
}

/** The key's last entry while departments are ticked: what a faded chip means. */
function FadedLegendItem({ departments }: { departments: string[] }) {
  if (!departments.length) return null;
  return (
    <span className={styles.legendItem}>
      <span className={styles.legendDot} style={{ background: 'var(--ink-500)', opacity: 0.3 }} />
      Other departments, faded
    </span>
  );
}

function LocationBox({ where }: { where: Where }) {
  const path = [where.site, where.building].filter(Boolean).join(' / ');
  return (
    <div className={styles.where}>
      <div className={styles.whereFloor}>{where.floor}</div>
      {path && <div className={styles.wherePath}>{path}</div>}
    </div>
  );
}

/** What a downloaded sheet is called: the floor and the day it was drawn, safe as a file name. */
export function printFileName(floorTitle: string, dateISO: string): string {
  const safe = floorTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'Floor plan';
  return `${safe} ${dateISO}.pdf`;
}

/**
 * The chip's size on paper at a layout zoom: the print's own 24px, but never wider than the gap to
 * its neighbours — as on screen (chipScreenSize), a car park whose stalls sit closer than a chip
 * printed them over each other. Paper only ever shrinks a chip, never grows one, so a floor with
 * room to spare prints as it always has.
 */
function printChipSize(markers: Unit[], zoom: number): number {
  const pts = markers.filter((m) => m.geom.kind === 'point' && m.type !== 'amenity').map((m) => ({ id: m.id, x: (m.geom as { x: number }).x * IMG_W, y: (m.geom as { y: number }).y * IMG_H }));
  const footprint = pts.length >= 2 ? deskPitch(pts) * CHIP_FOOTPRINT_OF_PITCH : null;
  return Math.min(CHIP_PX, chipScreenSize(zoom, footprint));
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
  const typography = typographyOf(state.labelStyle);
  // Chips first, then the room names clear of them, then the desk cards clear of both — as on screen.
  // As on screen, the ticked departments' desks are labelled and the rest faded (activeDepartments).
  const departments = activeDepartments(state);
  const chipSize = printChipSize(markers, zoom / labelScale);
  const inputs = useMemo(
    () => markerLabelInputs(state, markers, { personal: false, departments, keepSelected: false, chipSize, measure: sharedLabelTextMeasurer() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, labelScale],
  );
  const roomLabelPlan = useMemo(
    () => {
      const z = zoom / labelScale;
      const chipBoxes = inputs.map((i) => ({ x: i.x * IMG_W * z - i.size / 2, y: i.y * IMG_H * z - i.size / 2, w: i.size, h: i.size }));
      return planRoomLabels(roomLabelInputs(state, rooms, { measure: sharedLabelTextMeasurer() }), { planW: IMG_W, planH: IMG_H, zoom: z, reserved: chipBoxes });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, labelScale],
  );
  const labelPlan = useMemo(
    () =>
      planMarkerLabels(inputs, {
        planW: IMG_W,
        planH: IMG_H,
        zoom: zoom / labelScale,
        typography,
        reserved: [...roomLabelPlan.values()].map((p) => p.box),
      }),
    // Built once per page, from the state at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, labelScale],
  );
  // Each marker's model (chip colours, holder, title), once per page — see lib/markerModel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const models = useMemo(() => new Map(markers.map((m) => [m.id, markerModel(state, m, { personal: false, departments })])), [zoom, labelScale]);
  const invZ = labelScale / zoom;
  const ox = VIEW_FRAME_W / 2 - cx * zoom;
  const oy = VIEW_FRAME_H / 2 - cy * zoom;

  return (
    <div
      className={styles.plane}
      style={{ width: IMG_W, height: IMG_H, transform: `translate(${ox}px, ${oy}px) scale(${zoom})`, ['--inv' as string]: invZ, ['--chip' as string]: chipSize / CHIP_PX }}
    >
      <FloorplanBackground imageUrl={state.floorImages[floorImageKey(state.floorId, state.planId)]} />
      {rooms.map((r) => (
        <RoomPolygon key={r.id} unit={r} />
      ))}
      {rooms.map((r) => {
        const placement = roomLabelPlan.get(r.id);
        return placement ? <RoomLabel key={`l-${r.id}`} unit={r} placement={placement} /> : null;
      })}
      {markers.map((m) => (
        <Marker key={m.id} model={models.get(m.id)!} labels={labelPlan.get(m.id)} typography={typography} />
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
  pageNo,
  pageCount,
}: {
  area: DetailArea & { labelScale: number };
  index: number;
  count: number;
  where: Where;
  pageNo: number;
  pageCount: number;
}) {
  const { state } = useFloorplan();
  const departments = activeDepartments(state);
  const [one, many] = DETAIL_NOUN[state.planId] ?? DETAIL_NOUN.workstation;
  return (
    <div className={styles.page} data-print-page="">
      <div className={styles.bar}>
        <LocationBox where={where} />
        <span className={styles.barLabel}>
          Detail {index + 1} of {count}
        </span>
        <DepartmentsBox departments={departments} />
        <span className={styles.spacer} />
        <span className={styles.statPlain}>
          {many} <b>{area.deskIds.length}</b>
        </span>
      </div>

      <div className={styles.legend}>
        {legendItems(state).map((it) => (
          <span key={it.label} className={styles.legendItem}>
            {it.glyph ? <LegendSwatch item={it} size={7} /> : <span className={styles.legendDot} style={{ background: it.color }} />}
            {it.label}
          </span>
        ))}
        <FadedLegendItem departments={departments} />
      </div>

      <div className={styles.planWrap}>
        <div className={[styles.plan, styles.planView].join(' ')}>
          <PrintZoomedPlan cx={area.cx} cy={area.cy} zoom={area.zoom} labelScale={area.labelScale} />
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>
          {departments.length > 0
            ? `Every ${departmentNames(departments)} ${one} in this area, with who is placed there; other departments are faded. The whole floor is on page 1.`
            : `Every ${one} in this area, with who is placed there. The whole floor is on page 1.`}
        </span>
        <span className={styles.pageNo}>
          Page {pageNo} of {pageCount}
        </span>
      </div>
    </div>
  );
}

/**
 * One page of a register: a row per desk, stall, locker or room, a column per detail, the columns
 * grouped by where they come from (the space's record, the person's employee record, a stall's
 * dates, a room's booking). The header repeats on every page; an empty value prints as a dash,
 * never as an invented one.
 */
function RegisterPage({
  kind,
  rows,
  cols,
  ctx,
  index,
  count,
  total,
  print,
  departments,
  bookingWindow,
  where,
  pageNo,
  pageCount,
}: {
  kind: RegisterKind;
  rows: Unit[];
  cols: RegisterColumn[];
  ctx: RegisterContext;
  index: number;
  count: number;
  total: number;
  print: AppState['printRegisters'][RegisterKind];
  /** The departments ticked on screen; the register lists their spaces only (none for rooms). */
  departments: string[];
  /** The date and hours a room register's bookings are for. */
  bookingWindow: string;
  where: Where;
  pageNo: number;
  pageCount: number;
}) {
  const type = registerType(cols.length);
  const width = cols.reduce((a, c) => a + c.width, 0);
  const catalog = REGISTERS[kind];
  const many = catalog.many[0].toUpperCase() + catalog.many.slice(1);
  return (
    <div className={styles.page} data-print-page="">
      <div className={styles.bar}>
        <LocationBox where={where} />
        <span className={styles.barLabel}>
          {catalog.title} {index + 1} of {count}
        </span>
        <span className={styles.spacer} />
        <span className={styles.statPlain}>
          {many} <b>{total}</b>
        </span>
      </div>
      <div className={styles.regFilters}>
        {departments.length > 0 && <span>{departments.length === 1 ? 'Department' : 'Departments'}: {departmentNames(departments)}</span>}
        {kind === 'room' && <span>Bookings for {bookingWindow}</span>}
        <span>{catalog.rowsText[print.rows]}</span>
        <span>Sorted by {(catalog.sorts.find((s) => s.value === print.sort) ?? catalog.sorts[0]).text}</span>
        <span>{cols.length} columns</span>
      </div>
      <table className={styles.reg} style={{ fontSize: type.font }}>
        <colgroup>
          {cols.map((c) => (
            <col key={c.key} style={{ width: `${((100 * c.width) / width).toFixed(2)}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr className={styles.regGroups}>
            {catalog.groups.map((g) => {
              const span = cols.filter((c) => c.group === g.key).length;
              return span ? (
                <th key={g.key} colSpan={span}>
                  <span>{g.label}</span>
                </th>
              ) : null;
            })}
          </tr>
          <tr className={styles.regCols}>
            {cols.map((c) => (
              <th key={c.key}>{c.head ?? c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} style={{ height: type.row }}>
              {cols.map((c) => {
                const v = registerCell(u, c.key, ctx);
                if (c.key === 'status' && v) {
                  const s = v.toLowerCase();
                  return (
                    <td key={c.key}>
                      <span className={[styles.regStatus, s === 'occupied' || s === 'booked' ? styles.regOccupied : s === 'vacant' || s === 'free' ? styles.regVacant : ''].join(' ')}>{v}</span>
                    </td>
                  );
                }
                return v ? (
                  <td key={c.key} className={c.key === 'name' || c.key === 'label' ? styles.regKey : undefined}>
                    {v}
                  </td>
                ) : (
                  <td key={c.key} className={styles.regEmpty}>
                    —
                  </td>
                );
              })}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={cols.length} className={styles.regEmpty}>
                No {catalog.many} to list.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className={[styles.foot, styles.regFoot].join(' ')}>
        <span className={styles.footNote}>{catalog.source}</span>
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
function PrintPlan() {
  const { state } = useFloorplan();
  const rooms = planRooms(state);
  const markers = planMarkers(state);
  const typography = typographyOf(state.labelStyle);
  // As on screen, the ticked departments' desks are labelled and the rest faded (activeDepartments).
  const departments = activeDepartments(state);
  const chipSize = printChipSize(markers, PRINT_ZOOM);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inputs = useMemo(() => markerLabelInputs(state, markers, { personal: false, departments, keepSelected: false, chipSize, measure: sharedLabelTextMeasurer() }), []);
  const roomLabelPlan = useMemo(
    () => {
      const chipBoxes = inputs.map((i) => ({ x: i.x * IMG_W * PRINT_ZOOM - i.size / 2, y: i.y * IMG_H * PRINT_ZOOM - i.size / 2, w: i.size, h: i.size }));
      return planRoomLabels(roomLabelInputs(state, rooms, { measure: sharedLabelTextMeasurer() }), { planW: IMG_W, planH: IMG_H, zoom: PRINT_ZOOM, reserved: chipBoxes });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const labelPlan = useMemo(
    () =>
      planMarkerLabels(inputs, {
        planW: IMG_W,
        planH: IMG_H,
        zoom: PRINT_ZOOM,
        typography,
        reserved: [...roomLabelPlan.values()].map((p) => p.box),
      }),
    // Built once per print, from the state at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const models = useMemo(() => new Map(markers.map((m) => [m.id, markerModel(state, m, { personal: false, departments })])), []);
  const invZ = 1 / PRINT_ZOOM;

  return (
    <div
      className={styles.plane}
      style={{ width: IMG_W, height: IMG_H, transform: `scale(${PRINT_ZOOM})`, ['--inv' as string]: invZ, ['--chip' as string]: chipSize / CHIP_PX }}
    >
      <FloorplanBackground imageUrl={state.floorImages[floorImageKey(state.floorId, state.planId)]} />
      {rooms.map((r) => (
        <RoomPolygon key={r.id} unit={r} />
      ))}
      {rooms.map((r) => {
        const placement = roomLabelPlan.get(r.id);
        return placement ? <RoomLabel key={`l-${r.id}`} unit={r} placement={placement} /> : null;
      })}
      {markers.map((m) => (
        <Marker key={m.id} model={models.get(m.id)!} labels={labelPlan.get(m.id)} typography={typography} />
      ))}
    </div>
  );
}

