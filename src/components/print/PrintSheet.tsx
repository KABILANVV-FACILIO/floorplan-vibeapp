import { useFloorplan } from '../../state/FloorplanContext';
import { bookedUnitIds, floorMeta, visibleUnits } from '../../state/selectors';
import { unitCenter } from '../../lib/geometry';
import { floorImageKey, unitOnPlan } from '../../lib/types';
import type { Unit, UnitType } from '../../lib/types';
import { orgNow } from '../../lib/orgTime';
import styles from './PrintSheet.module.css';

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

  // The same set the canvas draws: module switched on, on this plan type, actually placed.
  const units = visibleUnits(state).filter(
    (u) => u.type !== 'amenity' && !u.unplaced && unitOnPlan(u, state.planId) && (u.geom.kind === 'point' || u.geom.pts.length > 0),
  );
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
          <div className={styles.brandRow}>
            <span className={styles.wordmark}>
              facilio<span className={styles.wordmarkDot}>.</span>
            </span>
            <span className={styles.brandRule} />
            <span className={styles.eyebrow}>Seat occupancy</span>
          </div>
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
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: 'var(--blue-500)' }} />
          Occupied
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: 'var(--success-500)' }} />
          Available
        </span>
        <span className={styles.spacer} />
        <span className={styles.totalLine}>
          {occupied} of {total} units occupied
        </span>
      </div>

      <div className={styles.planWrap}>
        <div className={styles.plan}>
          {planImage && <img className={styles.planImg} src={planImage} alt="" />}
          {units.map((u) => {
            // A room is a polygon on screen; on the sheet it is a dot at its centre, like the
            // design drew it — a traced outline at this scale reads as noise.
            const { cx, cy } = unitCenter(u);
            return (
              <div
                key={u.id}
                className={styles.seat}
                style={{
                  left: `${cx * 100}%`,
                  top: `${cy * 100}%`,
                  borderRadius: u.type === 'parking' ? '3px' : '999px',
                  background: isOccupied(u) ? 'var(--blue-500)' : 'var(--success-500)',
                }}
              />
            );
          })}
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.footNote}>Occupancy reflects assignments and confirmed bookings at the time of printing.</span>
        <span className={styles.spacer} />
        <span className={styles.sheetLine}>facilio Workplace · {floorTitle}</span>
      </div>
    </div>
  );
}
