import { useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { useFloorplan } from '../../state/FloorplanContext';
import { bookedUnitIds, floorMeta, markerLabelInputs, planMarkers, planRooms, visibleUnits } from '../../state/selectors';
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
 * Rendered always, shown only on paper (see the module CSS), so the browser's print preview is
 * the preview and Cmd+P produces the sheet without going near the toolbar button.
 *
 * THE PLAN is drawn the way the viewer draws it, by the viewer's own components — the real image,
 * room outlines, the same marker chips and the same labels — rather than a washed-out picture with
 * a dot per unit. The design this was ported from drew it as a separate, simpler picture, and the
 * result was a sheet that did not look like the floor anyone had just been looking at. It is the
 * whole floor fitted to the page: the plane at its native 1492×1054, scaled down exactly the way
 * the viewer scales it, so every chip and label lands where it does on screen.
 */

/** The modules the sheet reports, in the design's order. Amenities carry no occupancy. */
const CARD_TYPES: { type: UnitType; name: string }[] = [
  { type: 'workstation', name: 'Desks' },
  { type: 'room', name: 'Rooms' },
  { type: 'locker', name: 'Lockers' },
  { type: 'parking', name: 'Parking' },
];

export function PrintSheet() {
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
  const planImage = state.floorImages[floorImageKey(state.floorId, state.planId)];

  return (
    <div className={styles.sheet}>
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
        <div className={styles.plan}>{printing && <PrintPlan />}</div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>Occupancy reflects assignments and confirmed bookings at the time of printing.</span>
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
      {markers.map((m) => (
        <Marker key={m.id} unit={m} invZ={invZ} labels={labelPlan.get(m.id)} />
      ))}
    </div>
  );
}

