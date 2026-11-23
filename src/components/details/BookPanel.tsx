import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { bookedUnitIds, conflictsFor, contactName, isBookable, unitById, visibleUnits } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import type { Booking } from '../../lib/types';
import { DatePicker } from '../primitives/DatePicker';
import { Select } from '../primitives/Select';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { SkeletonRows } from '../primitives/Skeleton';
import { PeopleCard } from './AssignPanel';
import card from './Card.module.css';
import styles from './BookPanel.module.css';

const TIME_OPTIONS = Array.from({ length: (1200 - 420) / 30 + 1 }, (_, i) => 420 + i * 30).map((m) => ({ value: String(m), label: fmtTime(m) }));

const WIN_S = 420;
const WIN_E = 1200;
const PXH = 28;
/** What a click on the timeline selects, before the edges are dragged. */
const CLICK_MIN = 30;

export function BookPanel() {
  const { state, actions } = useFloorplanData();
  const sel = unitById(state, state.selected);
  // Through `visibleUnits`, so a module switched off in Settings leaves no bookable resources
  // behind — the availability count and the "N free" summary are user-facing surfaces like any
  // other, and were still counting parking stalls and rooms from disabled modules.
  const bookable = visibleUnits(state).filter(isBookable);
  const bookedIds = bookedUnitIds(state);
  const availCount = bookable.filter((u) => !bookedIds.has(u.id)).length;

  return (
    <div className={styles.stack}>
      <div className={card.card}>
        <div className={card.cardHead}>
          <h3 className={card.cardTitle}>Time window</h3>
        </div>
        <div className={card.cardBody}>
          <label className={card.label}>Date</label>
          <DatePicker value={state.date} onChange={(iso) => actions.setDate(iso)} fullWidth aria-label="Date" />
          <div className={styles.timeRow}>
            <div style={{ flex: 1 }}>
              <label className={card.label}>Start</label>
              <Select
                value={String(state.start)}
                options={TIME_OPTIONS}
                onChange={(v) => actions.setTimeRange(Number(v), Math.max(Number(v) + 15, state.end))}
                fullWidth
                aria-label="Start time"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className={card.label}>End</label>
              <Select
                value={String(state.end)}
                options={TIME_OPTIONS}
                onChange={(v) => actions.setTimeRange(Math.min(state.start, Number(v) - 15), Number(v))}
                fullWidth
                aria-label="End time"
              />
            </div>
          </div>
          <div className={styles.countRow}>
            <span className={styles.countPill} style={{ background: 'var(--success-050)', color: 'var(--success-700)' }}>
              {availCount} available
            </span>
            <span className={styles.countPill} style={{ background: 'var(--danger-050)', color: 'var(--danger-700)' }}>
              {bookable.length - availCount} booked
            </span>
          </div>
        </div>
      </div>

      {sel && isBookable(sel) && (
        <div className={card.card}>
          <div className={card.cardHead} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 className={card.cardTitle}>{sel.label}</h3>
            <div className={styles.viewToggle}>
              <button className={state.schedView === 'list' ? styles.viewBtnActive : styles.viewBtn} onClick={() => actions.setSchedView('list')}>
                List
              </button>
              <button className={state.schedView === 'calendar' ? styles.viewBtnActive : styles.viewBtn} onClick={() => actions.setSchedView('calendar')}>
                Calendar
              </button>
            </div>
          </div>
          <div className={card.cardBody}>
            {state.schedView === 'list' ? <ScheduleList unitId={sel.id} /> : <DayTimeline unitId={sel.id} />}
            {!bookedIds.has(sel.id) || conflictsFor(state.bookings, sel.id, state.date, state.start, state.end).length === 0 ? (
              <Button variant="primary" fullWidth style={{ marginTop: 12 }} onClick={() => actions.openBookingForm({ unitId: sel.id, date: state.date, start: state.start, end: state.end })}>
                New booking
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {sel && !isBookable(sel) && (
        <div className={card.card}>
          <div className={card.cardBody}>
            <p className={card.helper}>Lockers are assigned via Assignment mode, not booked.</p>
          </div>
        </div>
      )}
      {!sel && (
        <div className={card.card}>
          <div className={card.cardBody}>
            <p className={card.helper}>Select a desk, room, or parking stall on the plan to see its schedule and book it.</p>
          </div>
        </div>
      )}
      {/* Booking without Assignment has no other way to the People list, so it follows here, at a
          height of its own — this stack scrolls, and a list as tall as the directory would bury
          the booking above it. */}
      {!state.planViews.assign && <PeopleCard fixed />}
    </div>
  );
}

/**
 * The selected space's bookings for the day. Cancel asks "are you sure?" first — one click used to
 * cancel the booking on the org — and a row's Cancel stays disabled while its cancel is on its way,
 * so a double click can't send it twice and report "cancelled" then "not cancelled".
 */
function ScheduleList({ unitId }: { unitId: string }) {
  const { state, actions } = useFloorplanData();
  const [confirming, setConfirming] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const dayBookings = state.units.length
    ? state.bookings.filter((b) => b.unitId === unitId && b.date === state.date).sort((a, b) => a.start - b.start)
    : [];

  async function cancel(b: Booking) {
    setCancelling((s) => new Set(s).add(b.id));
    try {
      await actions.cancelBooking(b.id);
    } finally {
      setCancelling((s) => {
        const n = new Set(s);
        n.delete(b.id);
        return n;
      });
    }
  }

  if (state.loading) return <SkeletonRows rows={3} />;
  if (!dayBookings.length) return <p className={card.helper}>No bookings for this date.</p>;
  return (
    <div className={styles.list}>
      {confirming && (
        <ConfirmDialog
          title="Cancel this booking?"
          confirmLabel="Cancel booking"
          cancelLabel="Keep booking"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const b = confirming;
            setConfirming(null);
            void cancel(b);
          }}
        >
          {fmtTime(confirming.start)}–{fmtTime(confirming.end)}
          {contactName(state, confirming.by) ? `, booked by ${contactName(state, confirming.by)}` : ''}. The space is free for others to book again.
        </ConfirmDialog>
      )}
      {dayBookings.map((b) => (
        <div key={b.id} className={styles.listRow}>
          <div className={styles.listTime}>
            {fmtTime(b.start)}–{fmtTime(b.end)}
          </div>
          <div className={styles.listMeta}>
            <div className={styles.listBy}>{contactName(state, b.by)}</div>
            {b.purpose && <div className={styles.listPurpose}>{b.purpose}</div>}
          </div>
          <button
            type="button"
            className={styles.cancelLink}
            disabled={cancelling.has(b.id)}
            aria-label={`Cancel the ${fmtTime(b.start)}–${fmtTime(b.end)} booking`}
            onClick={() => setConfirming(b)}
          >
            {cancelling.has(b.id) && <ButtonSpinner />}
            Cancel
          </button>
        </div>
      ))}
    </div>
  );
}

function yAt(m: number) {
  return ((Math.max(WIN_S, Math.min(WIN_E, m)) - WIN_S) / 60) * PXH;
}

function minutesAtClientY(rect: DOMRect, clientY: number, snap: number) {
  const y = clientY - rect.top;
  let m = Math.round((y / PXH) * 60 + WIN_S);
  m = Math.round(m / snap) * snap;
  return Math.max(WIN_S, Math.min(WIN_E, m));
}

function DayTimeline({ unitId }: { unitId: string }) {
  const { state, actions } = useFloorplanData();
  const height = ((WIN_E - WIN_S) / 60) * PXH;
  const dayBookings = state.bookings.filter((b) => b.unitId === unitId && b.date === state.date);
  const hours = Array.from({ length: (WIN_E - WIN_S) / 60 + 1 }, (_, i) => WIN_S + i * 60);
  const timelineRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ edge: 'top' | 'bottom' } | null>(null);
  /** Takes a resize's window listeners off again — on release, or if the panel goes mid-drag. */
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => () => detachRef.current?.(), []);

  function onClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (resizeRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // A click picks a half-hour to start from; the edges then stretch it to any length.
    const m = Math.min(WIN_E - CLICK_MIN, minutesAtClientY(rect, e.clientY, CLICK_MIN));
    actions.setTimeRange(m, m + CLICK_MIN);
  }

  function onEdgeDown(edge: 'top' | 'bottom', e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { edge };
    const onMove = (ev: MouseEvent) => {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect) return;
      const m = minutesAtClientY(rect, ev.clientY, 15);
      if (edge === 'top') actions.setTimeRange(Math.min(m, state.end - 15), state.end);
      else actions.setTimeRange(state.start, Math.max(m, state.start + 15));
    };
    const detach = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      detachRef.current = null;
    };
    const onUp = () => {
      detach();
      setTimeout(() => (resizeRef.current = null), 0);
    };
    detachRef.current?.();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    detachRef.current = detach;
  }

  return (
    <div ref={timelineRef} className={styles.timeline} style={{ height }} onClick={onClick}>
      {hours.map((h) => (
        <div key={h} className={styles.hourLine} style={{ top: yAt(h) }}>
          <span className={styles.hourLabel}>{fmtTime(h)}</span>
        </div>
      ))}
      {dayBookings.map((b) => {
        const top = yAt(b.start);
        const h = Math.max(16, yAt(b.end) - top);
        const mine = b.by === state.bookBy;
        const label = mine ? 'Your booking' : 'Booked';
        return (
          <div
            key={b.id}
            className={styles.block}
            style={{
              top,
              height: h,
              background: mine ? 'var(--blue-050)' : 'var(--danger-050)',
              borderColor: mine ? 'var(--blue-400)' : 'var(--danger-500)',
              color: mine ? 'var(--blue-700)' : 'var(--danger-700)',
            }}
            data-tip={`${label} · ${fmtTime(b.start)}–${fmtTime(b.end)} · ${contactName(state, b.by)}${b.purpose ? ' · ' + b.purpose : ''}`}
          >
            {h >= 22 && (
              <span className={styles.blockLabel}>
                {label} · {fmtTime(b.start)}–{fmtTime(b.end)}
              </span>
            )}
          </div>
        );
      })}
      {state.end > state.start && (
        <div className={styles.selBlock} style={{ top: yAt(state.start), height: Math.max(14, yAt(state.end) - yAt(state.start)) }}>
          <div className={styles.selHandle} style={{ top: -4 }} onMouseDown={(e) => onEdgeDown('top', e)} />
          <div className={styles.selHandle} style={{ bottom: -4 }} onMouseDown={(e) => onEdgeDown('bottom', e)} />
        </div>
      )}
    </div>
  );
}
