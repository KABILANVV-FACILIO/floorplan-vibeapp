import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, isAssignable, isBookable, moduleEnabled, unitById } from '../../state/selectors';
import { fmtTime, tooltipPlacement, unitCenter } from '../../lib/geometry';
import { unitStatus } from '../../lib/unitStatus';
import { StatusPill } from '../primitives/StatusPill';
import { Button } from '../primitives/Button';
import { DESK_TYPES, isRoomLike, resolveMarkerDef, TYPE_META } from '../../lib/types';
import { fetchUnitRecordInfo, resolveUnitRecord } from '../../lib/facilioApiDataSource';
import { StateflowActions } from '../details/StateflowActions';
import type { UnitRecordInfo } from '../../lib/facilioApiDataSource';
import styles from './Tooltip.module.css';

export function Tooltip() {
  const { state, actions } = useFloorplan();
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The card's own box, measured after it renders — its height depends on which sections and
  // buttons this unit and mode produce, and placement can't clear the stage edges without it.
  // Measured in a layout effect so the corrected position is painted in the same frame.
  const [size, setSize] = useState<{ w: number; h: number } | undefined>(undefined);

  // The selected unit's ORG RECORD — its own state and the fields the org filled in. The popover
  // could otherwise only show what a Unit carries locally, which says nothing about the record.
  const [record, setRecord] = useState<UnitRecordInfo | null>(null);
  const [recordNonce, setRecordNonce] = useState(0);

  const unit = unitById(state, state.selected);
  // A unit whose module was switched off in Settings must leave no trace — including a card left
  // open over a marker the canvas has already stopped drawing.
  //
  // An `unplaced` record has no position on the plan (its geometry is a 0,0 placeholder), so a
  // card for one pins to the plan's top-left corner and points at nothing. A zone with no points
  // is worse: `unitCenter` reduces an empty list to Infinity and the card's coordinates come out
  // NaN, which React drops — leaving it stuck at the stage origin, pushed out of view.
  const placeable = !!unit && !unit.unplaced && (unit.geom.kind === 'point' || unit.geom.pts.length > 0);
  const visible = !!unit && placeable && moduleEnabled(state, unit.type);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => {
      const { offsetWidth: w, offsetHeight: h } = el;
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [unit?.id, state.mode, visible, record]);

  const unitId = unit?.id;
  const unitType = unit?.type;
  useEffect(() => {
    setRecord(null);
    if (!unitId || !unitType || !placeable) return;
    let live = true;
    void fetchUnitRecordInfo({ id: unitId, type: unitType }).then((info) => {
      if (live) setRecord(info);
    });
    return () => {
      live = false;
    };
  }, [unitId, unitType, placeable, recordNonce]);

  if (!unit || !visible) return null;

  const { cx, cy } = unitCenter(unit);
  const place = tooltipPlacement(cx, cy, state.view, state.stage, size);
  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const contactId = state.assignments[unit.id];

  // Amenity/asset markers are informational — no booking/assignment concept,
  // so they skip the status pill, action buttons, and any mode notes.
  const isAmenity = unit.type === 'amenity';
  const isAsset = isAmenity && !!unit.assetId;

  const markerName = isAmenity && (unit.markerKind || unit.icon) ? resolveMarkerDef(state.customMarkers, unit).name : 'Amenity';
  const primaryLabel = isAsset
    ? 'Asset'
    : isAmenity
      ? markerName
      : unit.type === 'workstation'
        ? 'Desk'
        : TYPE_META[unit.type].name;
  const primary = unit.label;
  // Only amenities carry a meaningful `secondary` (an asset's "category · detail").
  const amenityDetail = unit.secondary || (unit.markerKind || unit.icon ? markerName : 'Marker');

  // A record's details, every one read off the unit or the org's own state — nothing invented.
  // Who the ORG says holds it, falling back to the app's own assignment map — which is what you
  // see before a save, and all there is on a demo floor.
  const holder = record?.employee ?? (contactId ? contactName(state, contactId) : null);
  const todaysBooking = state.bookings
    .filter((b) => b.unitId === unit.id && b.date === state.date)
    .sort((a, b) => a.start - b.start)[0];
  const recordId = resolveUnitRecord(unit)?.recordId ?? null;

  // The card reports each thing ONCE. `Type` is already the eyebrow, the holder gets its own
  // block below, and the record's state is the pill — repeating them as rows produced a card
  // that said "Free", "Record status: Vacant" and "State: Vacant" one under the other.
  const details: { label: string; value: string }[] = [];
  if (!isAmenity) {
    if (unit.type === 'workstation') {
      const deskType = DESK_TYPES.find((d) => d.id === (unit.deskType ?? 'ASSIGNED'));
      if (deskType) details.push({ label: 'Desk type', value: deskType.name });
    }
    if (isRoomLike(unit.type)) details.push({ label: 'Reservable', value: unit.isReservable === false ? 'No' : 'Yes' });
    if (unit.room) details.push({ label: 'Room', value: unit.room });
    if (todaysBooking) {
      details.push({ label: 'Booked', value: `${fmtTime(todaysBooking.start)}–${fmtTime(todaysBooking.end)}` });
    }
    for (const f of record?.fields ?? []) details.push(f);
  }

  // The status is always a TAG, and the record's own state wins over the app's computed one — it
  // is what the org says this thing is. The app's word ("Free") only stands in when the record
  // has no state, or before the record has been read.
  const statusText = record?.status ?? status.text;

  const bookable = isBookable(unit);
  const assignable = isAssignable(unit);
  const booked = status.key === 'booked';

  return (
    <div
      ref={cardRef}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={styles.card}
      style={{ left: place.sx, top: place.sy, transform: place.transform }}
    >
      <div className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.eyebrowRow}>
            <span className={styles.eyebrow}>{primaryLabel}</span>
            {recordId != null && <span className={styles.recordId}>#{recordId}</span>}
          </div>
          <div className={styles.name}>{primary}</div>
        </div>
        <button className={styles.close} data-tip="Close" onClick={() => actions.selectUnit(null)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      {isAmenity ? (
        <div className={styles.section}>
          <div className={styles.eyebrow}>Details</div>
          <div className={styles.value}>{amenityDetail}</div>
        </div>
      ) : (
        <div className={styles.details}>
          {holder && (
            <div className={styles.holder}>
              <div className={styles.eyebrow}>Assigned to</div>
              <div className={styles.holderName}>{holder}</div>
            </div>
          )}
          {details.map((d) => (
            <div key={d.label} className={styles.detailRow}>
              <span className={styles.detailLabel}>{d.label}</span>
              <span className={styles.detailValue}>{d.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Everything below is booking/assignment — irrelevant for amenities/assets. */}
      {!isAmenity && (
      <>
      <div className={styles.statusRow}>
        <StatusPill label={statusText} bg={status.bg} fg={status.fg} />
      </div>

      <StateflowActions unit={unit} showState={false} onChanged={() => setRecordNonce((n) => n + 1)} />

      {state.mode === 'book' && bookable && !booked && (
        <Button variant="primary" fullWidth style={{ marginTop: 10 }} onClick={() => actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end })}>
          Book
        </Button>
      )}
      {state.mode === 'book' && bookable && booked && (
        <Button variant="secondary" fullWidth style={{ marginTop: 10 }} onClick={() => actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end })}>
          Manage bookings
        </Button>
      )}
      {state.mode === 'assign' && assignable && !contactId && (
        <Button variant="primary" fullWidth style={{ marginTop: 10 }} onClick={() => actions.openPanel('details')}>
          Assign
        </Button>
      )}
      {state.mode === 'assign' && assignable && !!contactId && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <Button variant="danger" style={{ flex: 1, justifyContent: 'center' }} onClick={() => actions.vacate(unit.id)}>
            Vacate
          </Button>
          <Button
            variant="primary"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              actions.setWebReassign(unit.id);
            }}
          >
            Reassign
          </Button>
        </div>
      )}
      {state.mode === 'assign' && !assignable && (
        <div className={styles.note}>Booked in Booking mode, not assigned.</div>
      )}
      </>
      )}

      <div className={[styles.caret, place.below ? styles.caretBelow : styles.caretAbove].join(' ')} style={{ left: place.caretLeft }} />
    </div>
  );
}
