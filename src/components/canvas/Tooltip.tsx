import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, isAssignable, isBookable, moduleEnabled, unitById } from '../../state/selectors';
import { fmtTime, tooltipPlacement, unitCenter } from '../../lib/geometry';
import { unitStatus } from '../../lib/unitStatus';
import { StatusPill } from '../primitives/StatusPill';
import { SkeletonBlock } from '../primitives/Skeleton';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';
import { Button } from '../primitives/Button';
import { DESK_TYPES, isRoomLike, resolveMarkerDef, TYPE_META } from '../../lib/types';
import { fetchUnitRecordInfo, resolveUnitRecord } from '../../lib/facilioApiDataSource';
import { StateflowActions } from '../details/StateflowActions';
import { LocalAssign } from '../details/LocalAssign';
import type { UnitRecordInfo } from '../../lib/facilioApiDataSource';
import styles from './Tooltip.module.css';

/** The longest the card will claim to be reading a record before showing what it already knows. */
const RECORD_READ_TIMEOUT_MS = 12000;

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
  // Drop the previous record the moment the card points at a different one — its state and holder
  // would otherwise be read as this unit's for as long as the fetch takes. A re-read of the SAME
  // record keeps what's on screen until the new answer lands, since it is about this unit either way.
  useEffect(() => {
    setRecord(null);
  }, [unitId, unitType]);

  const [reading, setReading] = useState(false);
  useEffect(() => {
    // Reset FIRST, on every path. Returning early here without clearing left the flag raised from
    // the previous unit — a card that then rendered a loader with nothing in flight to end it.
    setReading(false);
    if (!unitId || !unitType || !placeable) return;
    let live = true;
    setReading(true);
    // A hard stop, for the same reason the busy flag has one: `fetchUnitRecordInfo` swallows its
    // own errors, so it always RESOLVES — but a request that never answers never resolves either,
    // and a shimmer with no end is worse than the app's own approximate status.
    const giveUp = window.setTimeout(() => {
      if (live) setReading(false);
    }, RECORD_READ_TIMEOUT_MS);
    void fetchUnitRecordInfo({ id: unitId, type: unitType }).then((info) => {
      if (live) {
        setRecord(info);
        setReading(false);
        clearTimeout(giveUp);
      }
    });
    return () => {
      live = false;
      clearTimeout(giveUp);
    };
    // `recordNonce` re-reads the record after ANY write to it — a transition fired here, or the
    // same one fired in the sidebar, which is showing the very record this card is about.
  }, [unitId, unitType, placeable, state.recordNonce]);

  /*
   * The record is either being READ or being CHANGED — either way the value on screen is not the
   * answer, and showing one anyway is worse than showing none.
   *
   * The app can compute "Free" from what it already knows, so the pill used to render that and
   * then flip to the record's own state ("Occupied", "Vacant") a moment later — the app appearing
   * to change its mind about a desk you just clicked. The same is true while a transition is in
   * flight: the state shown is the one being replaced.
   *
   * `useDelayedFlag` keeps a fast read from flashing a shimmer (nothing shows for the first
   * 180ms, so a cached answer just appears). It lives ABOVE the early return below, because a
   * hook that runs only for a visible card is a hook whose order changes between renders.
   */
  const recordPending =
    (reading && !!unitId && !!unitType && !!resolveUnitRecord({ id: unitId, type: unitType })) ||
    (!!unitId && state.busyUnitId === unitId);
  const showShimmer = useDelayedFlag(recordPending, { key: unitId ?? '', sticky: false });

  if (!unit || !visible) return null;

  const { cx, cy } = unitCenter(unit);
  const place = tooltipPlacement(cx, cy, state.view, state.stage, size);
  const status = unitStatus(state, unit, (id) => contactName(state, id));

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
  // Who the ORG says holds it — the record's `employee`, and only that. The app's own assignment
  // map used to stand in for it, which meant the card could name a holder the record doesn't have.
  const holder = record?.employee ?? null;
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
          {/* Every line on this card that can end in "…" carries its full text on hover — a long
              desk name, holder or department ("Project Implementat…") is otherwise unreadable
              here, and this card is where people go to read them. */}
          <div className={styles.name} data-tip={primary}>
            {primary}
          </div>
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
          {recordPending && (
            <div className={styles.holder}>
              <div className={styles.eyebrow}>Assigned to</div>
              {showShimmer ? <SkeletonBlock width={128} height={15} radius={4} /> : <span style={{ display: 'inline-block', height: 15 }} />}
            </div>
          )}
          {!recordPending && holder && (
            <div className={styles.holder}>
              <div className={styles.eyebrow}>Assigned to</div>
              <div className={styles.holderName} data-tip={holder}>
                {holder}
              </div>
            </div>
          )}
          {details.map((d) => (
            <div key={d.label} className={styles.detailRow}>
              <span className={styles.detailLabel}>{d.label}</span>
              <span className={styles.detailValue} data-tip={d.value}>
                {d.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Everything below is booking/assignment — irrelevant for amenities/assets. */}
      {!isAmenity && (
      <>
      <div className={styles.statusRow}>
        {recordPending ? (
          // Space reserved either way, so the card does not jump when the answer lands.
          showShimmer ? <SkeletonBlock width={104} height={22} /> : <span style={{ display: 'inline-block', height: 22 }} />
        ) : (
          <StatusPill label={statusText} bg={status.bg} fg={status.fg} />
        )}
      </div>

      {/* The same buttons the sidebar shows, from the same place — this card and the panel are two
          views of ONE record, and a user who can vacate a desk in one must not find the other
          silent about it. The app's own controls stand in here exactly as they do there, and only
          in Assign view, where assigning is what the card is for.

          Booking view shows them ONLY for a record you can actually book. The org's flow offers
          assignment transitions on every desk whatever tab is open, and a desk that can't be
          booked answering "Re-assign" under a Booking heading is an action about a different
          question — one this view cannot follow through on. Nothing is left unexplained: the
          status pill above already reads "Not bookable", or names the person it belongs to. */}
      {/* Edit mode shows none of the org's transitions either. Editing is about WHERE a record
          sits on the plan — its geometry, its label, its type — and a "Mark as In-active" button
          under an outline you are tracing is a record-lifecycle action in the middle of a layout
          task, one press from being fired by accident. */}
      {state.mode !== 'edit' && (state.mode !== 'book' || bookable) && (
        <StateflowActions
          unit={unit}
          showState={false}
          fallback={state.mode === 'assign' && assignable ? <LocalAssign unit={unit} /> : null}
        />
      )}

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
      {/* Assign / Re-assign / Vacate are NOT hardcoded here. They are stateflow transitions, so
          they come from `v2/statetransition/getAvailableState` via StateflowActions above —
          rendered only when the org's flow actually offers them from this record's state. */}
      {state.mode === 'assign' && !assignable && (
        <div className={styles.note}>Booked in Booking mode, not assigned.</div>
      )}
      </>
      )}

      <div className={[styles.caret, place.below ? styles.caretBelow : styles.caretAbove].join(' ')} style={{ left: place.caretLeft }} />
    </div>
  );
}
