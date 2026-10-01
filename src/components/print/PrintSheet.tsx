import { useEffect, useMemo, useState } from 'react';
import type { Ref } from 'react';
import { flushSync } from 'react-dom';
import { useFloorplan } from '../../state/FloorplanContext';
import { bookedUnitIds, floorMeta, markerLabelInputs, planMarkers, planRooms, roomLabelInputs, visibleUnits } from '../../state/selectors';
import { floorImageKey, unitOnPlan } from '../../lib/types';
import type { Unit } from '../../lib/types';
import type { AppState } from '../../state/types';
import { IMG_H, IMG_W } from '../../lib/mockData';
import { planMarkerLabels, planRoomLabels, typographyOf } from '../../lib/labelLayout';
import { FloorplanBackground } from '../canvas/FloorplanBackground';
import { RoomPolygon } from '../canvas/RoomPolygon';
import { RoomLabel } from '../canvas/Canvas';
import { Marker } from '../canvas/Marker';
import { markerModel } from '../../lib/markerModel';
import { sharedLabelTextMeasurer } from '../../lib/textMeasure';
import { legendItems } from '../canvas/Legend';
import { planLabelledDetailAreas } from '../../lib/printAreas';
import type { DetailArea } from '../../lib/printAreas';
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

  // The bar's figures: the floor's DESKS, occupied meaning someone
  // is assigned or a booking covers the window on screen. A floor with no desks counts its other
  // units instead, so the bar never reads "Total 0" above a plan full of lockers.
  const desks = units.filter((u) => u.type === 'workstation');
  const counted = desks.length ? desks : units;
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

  // "Floor + details": every area of desks on a page of its own, zoomed so each desk carries its
  // name above, and its holder and their department below (see lib/printAreas).
  const detailAreas = useMemo(() => {
    if (!showPlan || scope !== 'detail') return [];
    const markers = planMarkers(state);
    const desks = markers
      .filter((m) => m.type === 'workstation' && m.geom.kind === 'point')
      .map((m) => ({ id: m.id, x: (m.geom as { x: number }).x * IMG_W, y: (m.geom as { y: number }).y * IMG_H }));
    // A detail page shows every desk in FULL — its name, who holds it, their department — checked
    // with the same label layout the page draws with (PrintZoomedPlan); an area where one doesn't
    // fit is zoomed in further (see planLabelledDetailAreas).
    const inputs = markerLabelInputs(state, markers, { personal: false, measure: sharedLabelTextMeasurer() });
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
  const pageCount = 1 + detailAreas.length;

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
      </div>

      <div className={styles.planWrap}>
        <div className={[styles.plan, scope === 'view' ? styles.planView : ''].join(' ')}>
          {showPlan && (scope === 'view' ? <PrintViewPlan /> : <PrintPlan />)}
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>Occupancy reflects assignments and confirmed bookings at the time of printing.</span>
        {pageCount > 1 && (
          <span className={styles.pageNo}>
            Page 1 of {pageCount} · zoomed-in pages of every area follow
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
  const typography = typographyOf(state.labelStyle);
  // Chips first, then the room names clear of them, then the desk cards clear of both — as on screen.
  const inputs = useMemo(
    () => markerLabelInputs(state, markers, { personal: false, measure: sharedLabelTextMeasurer() }),
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
  const models = useMemo(() => new Map(markers.map((m) => [m.id, markerModel(state, m, { personal: false })])), [zoom, labelScale]);
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
      </div>

      <div className={styles.planWrap}>
        <div className={[styles.plan, styles.planView].join(' ')}>
          <PrintZoomedPlan cx={area.cx} cy={area.cy} zoom={area.zoom} labelScale={area.labelScale} />
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
function PrintPlan() {
  const { state } = useFloorplan();
  const rooms = planRooms(state);
  const markers = planMarkers(state);
  const typography = typographyOf(state.labelStyle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inputs = useMemo(() => markerLabelInputs(state, markers, { personal: false, measure: sharedLabelTextMeasurer() }), []);
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
  const models = useMemo(() => new Map(markers.map((m) => [m.id, markerModel(state, m, { personal: false })])), []);
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

