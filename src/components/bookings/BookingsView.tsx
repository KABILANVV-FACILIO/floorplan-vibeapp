import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { contactName, isBookable, mergeWithOrgPool } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { dataSource } from '../../lib/dataSource';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { bookingsScopedToUser, fetchOrgBookableResources, fetchOrgBookingsForRange } from '../../lib/facilioApiDataSource';
import { orgNow } from '../../lib/orgTime';
import type { Booking, Building, Floor, Site, Unit, UnitType } from '../../lib/types';
import { Button } from '../primitives/Button';
import { Modal, ModalHeader } from '../primitives/Modal';
import { BookingStateflowActions } from '../details/BookingStateflowActions';
import styles from './BookingsView.module.css';

/**
 * The bookings calendar: every booking in the org, on the org's clock, with the user's own
 * highlighted — not the floor on screen. The plan is where a floor is booked from; here the space
 * is picked in the form, from every hot desk and reservable room the org has, placed or not.
 */

/** Category tabs → the unit type they book. Lockers are assigned, never time-booked. */
type CategoryId = UnitType | 'all';
const BOOKABLE_TYPES: UnitType[] = ['workstation', 'room'];
const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'all', label: 'All spaces' },
  { id: 'workstation', label: 'Desks' },
  { id: 'room', label: 'Rooms' },
];

// The whole day — a booking is not limited to office hours (the grid opens scrolled to 07:00).
const DAY_START = 0;
const DAY_END = 24 * 60;
const PX_PER_HOUR = 52;
const PX_PER_MIN = PX_PER_HOUR / 60;
/**
 * The resolution a drag selects at — half an hour, the same step the form's time pickers use. A
 * resolution, not a length: a window is as long as the drag makes it, across days if it likes.
 */
const SNAP = 30;
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Inline filter chips shown before the rest collapse into a +N pill. */
const CHIP_LIMIT = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type CalView = 'day' | 'week' | 'month';

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}
function addDays(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
function startOfWeek(iso: string): string {
  return addDays(iso, -parseISO(iso).getDay());
}
function shiftMonth(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setMonth(d.getMonth() + n, 1);
  return toISO(d);
}
function monthGridDates(iso: string): string[] {
  const d = parseISO(iso);
  d.setDate(1);
  const first = addDays(toISO(d), -d.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}
// The ORG's clock, not the browser's — "now" and "today" are the facility's.
function nowMinutes(): number {
  return orgNow().minutes;
}
function orgTodayISO(): string {
  return orgNow().dateISO;
}
function shortDate(iso: string): string {
  const d = parseISO(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtDay(iso: string): string {
  return parseISO(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function BookingsView() {
  const { state, actions } = useFloorplanData();

  const [calView, setCalView] = useState<CalView>('week');
  const [focusDate, setFocusDate] = useState(state.date);
  const [category, setCategory] = useState<CategoryId>('all');
  // The default the form opens with; the space itself is picked in the form.
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [bookingsByDate, setBookingsByDate] = useState<Record<string, Booking[]>>({});
  const [calLoading, setCalLoading] = useState(true);
  /** The day preview: which bookings; the rows come from bookingsByDate so a transition updates them. */
  const [preview, setPreview] = useState<{ date: string; ids: string[] } | null>(null);
  const [myOpen, setMyOpen] = useState(false);
  // A portal user sees their own bookings (scoped by the org); the admin app sees everyone's.
  const scopedToUser = useMemo(() => isFacilioApiConfigured && bookingsScopedToUser(), []);
  const [refreshTick, setRefreshTick] = useState(0);
  // The floor filter rides the range request as an API filter, never as a client-side row filter.
  const [floorFilter, setFloorFilter] = useState<{ id: string; name: string }[]>([]);
  // Every bookable record in the org; the loaded floor's placed units win on an id collision
  // since they carry the richer data.
  const [orgUnits, setOrgUnits] = useState<Unit[]>([]);
  useEffect(() => {
    let alive = true;
    if (isFacilioApiConfigured) fetchOrgBookableResources().then((u) => alive && setOrgUnits(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const resources = useMemo(() => {
    const pool = mergeWithOrgPool(state.units, orgUnits);
    return pool
      .filter((u) => (category === 'all' ? BOOKABLE_TYPES.includes(u.type) : u.type === category) && isBookable(u))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [state.units, orgUnits, category]);

  // Keep a valid default selected as the category or the pool changes.
  useEffect(() => {
    if (!resources.length) setResourceId(null);
    else if (!resources.some((r) => r.id === resourceId)) setResourceId(resources[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources]);

  const visibleDates = useMemo(() => {
    if (calView === 'day') return [focusDate];
    if (calView === 'week') {
      const sow = startOfWeek(focusDate);
      return Array.from({ length: 7 }, (_, i) => addDays(sow, i));
    }
    return monthGridDates(focusDate);
  }, [calView, focusDate]);

  // ONE request for the whole visible range, grouped per day here. `bookingsNonce` bumps when a
  // booking is made or cancelled anywhere, so the shared form's write re-reads this too.
  useEffect(() => {
    let cancelled = false;
    setCalLoading(true);
    const first = visibleDates[0];
    const last = visibleDates[visibleDates.length - 1];
    const load: Promise<Booking[]> = isFacilioApiConfigured
      ? fetchOrgBookingsForRange(first, last, {
          ...(scopedToUser ? { forCurrentUser: true } : {}),
          ...(floorFilter.length ? { floorIds: floorFilter.map((f) => f.id) } : {}),
          ...(category === 'workstation' ? { resourceField: 'desk' as const } : category === 'room' ? { resourceField: 'space' as const } : {}),
        }).catch(() => [] as Booking[])
      : Promise.all(visibleDates.map((d) => dataSource.getBookings(state.floorId, d).catch(() => [] as Booking[]))).then((r) => r.flat());
    load.then((rows) => {
      if (cancelled) return;
      const map: Record<string, Booking[]> = {};
      for (const d of visibleDates) map[d] = [];
      for (const b of rows) (map[b.date] ??= []).push(b);
      setBookingsByDate(map);
      setCalLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [state.floorId, visibleDates, state.bookingsNonce, refreshTick, scopedToUser, floorFilter, category]);

  const myBookingsInRange = useMemo(() => {
    const mine: Booking[] = [];
    // A multi-day booking is one segment per day sharing the record id — ONE booking here, listed
    // on the day it starts.
    const listed = new Set<string>();
    for (const d of visibleDates) {
      for (const b of bookingsByDate[d] ?? []) {
        if (b.segCount && b.segIndex !== 0) continue;
        if (listed.has(b.id)) continue;
        listed.add(b.id);
        if (scopedToUser || b.by === state.bookBy) mine.push(b);
      }
    }
    return mine;
  }, [bookingsByDate, visibleDates, state.bookBy, scopedToUser]);

  function bookingsFor(date: string): Booking[] {
    return bookingsByDate[date] ?? [];
  }
  function unitOf(b: Booking): Unit | undefined {
    return state.units.find((u) => u.id === b.unitId) ?? orgUnits.find((u) => u.id === b.unitId);
  }

  // A drag opens the shared booking form on that window; the create happens on submit, and the
  // nonce-driven effect above re-reads.
  function openForm(date: string, start: number, end: number, endDate?: string) {
    if (!resourceId) {
      actions.showToast('Nothing bookable yet — in Facilio, mark desks as hot desks or spaces as reservable, then book them here', 6000);
      return;
    }
    const today = orgTodayISO();
    if (date < today) {
      actions.showToast('That day has already passed — pick an upcoming one');
      return;
    }
    // A slot that has already started cannot be booked: the org moves a past start to "now".
    if (date === today && start < nowMinutes()) {
      actions.showToast('That time has already passed — pick an upcoming one');
      return;
    }
    const picked = resources.find((r) => r.id === resourceId);
    actions.openBookingForm({
      unitId: resourceId,
      date,
      start,
      end,
      // All spaces mixes desks and rooms: the form's own picker decides which is booked.
      ...(category === 'all' ? { allowTypeSwitch: true } : {}),
      ...(picked ? { resourceUnit: picked } : {}),
      ...(floorFilter.length ? { floorIds: floorFilter.map((f) => f.id) } : {}),
      ...(endDate && endDate !== date ? { endDate } : {}),
    });
  }

  function cancelLocal(b: Booking) {
    void actions.cancelBooking(b.id);
    setBookingsByDate((prev) => ({ ...prev, [b.date]: (prev[b.date] ?? []).filter((x) => x.id !== b.id) }));
  }

  function stepFocus(dir: -1 | 1) {
    if (calView === 'day') setFocusDate(addDays(focusDate, dir));
    else if (calView === 'week') setFocusDate(addDays(focusDate, dir * 7));
    else setFocusDate(shiftMonth(focusDate, dir));
  }

  /** A row in "My bookings": focus the calendar on it. */
  function jumpToBooking(b: Booking) {
    const unit = unitOf(b);
    if (unit && (unit.type === 'workstation' || unit.type === 'room')) {
      setCategory(unit.type);
      setResourceId(unit.id);
    }
    setFocusDate(b.date);
    if (calView === 'month') setCalView('week');
    setMyOpen(false);
  }

  const rangeLabel = useMemo(() => {
    if (calView === 'day') {
      const d = parseISO(focusDate);
      return `${DAY_ABBR[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
    }
    if (calView === 'week') return `${shortDate(visibleDates[0])} – ${shortDate(visibleDates[6])}`;
    const d = parseISO(focusDate);
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }, [calView, focusDate, visibleDates]);

  /** One booking's card, in the day preview and in My bookings. */
  function bookingCard(b: Booking, opts: { titleAsJump?: boolean; showDate?: boolean; onCancelled?: () => void }) {
    const unit = unitOf(b);
    const title = unit?.label ?? b.name ?? `#${b.unitId}`;
    const span = b.segCount ? ` · day ${(b.segIndex ?? 0) + 1} of ${b.segCount}` : '';
    return (
      <div key={b.id} style={{ border: '1px solid var(--ink-200)', borderRadius: 10, padding: '10px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          {opts.titleAsJump ? (
            <button
              type="button"
              data-tip="Show on the calendar"
              onClick={() => jumpToBooking(b)}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: '600 13.5px var(--font-sans)', color: 'var(--blue-600)', textAlign: 'left' }}
            >
              {title}
            </button>
          ) : (
            <span style={{ font: '600 13.5px var(--font-sans)', color: 'var(--ink-900)' }}>{title}</span>
          )}
          <span style={{ font: '500 12px var(--font-sans)', color: 'var(--ink-600)', whiteSpace: 'nowrap' }}>
            {opts.showDate ? `${fmtDay(b.date)} · ` : ''}
            {fmtTime(b.start)}–{fmtTime(b.end)}
            {span}
          </span>
        </div>
        <div style={{ font: '400 12.5px/1.4 var(--font-sans)', color: 'var(--ink-600)', marginTop: 2 }}>
          {b.by === state.bookBy ? 'You' : contactName(state, b.by) || 'Booked'}
          {b.purpose ? ` · ${b.purpose}` : ''}
          {b.approvalPending ? ' · pending approval' : ''}
        </div>
        {/* A real record: its state and whatever the org's flow allows on it. A local one: plain Cancel. */}
        {/^\d+$/.test(b.id) ? (
          <BookingStateflowActions recordId={Number(b.id)} onChanged={() => setRefreshTick((t) => t + 1)} />
        ) : (
          <Button
            variant="danger"
            style={{ marginTop: 8 }}
            onClick={() => {
              cancelLocal(b);
              opts.onCancelled?.();
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.h1}>Bookings</h1>
            <p className={styles.sub}>Every booking across the org — book any hot desk or reservable room, for as long as you need</p>
          </div>
          <div className={styles.headerActions}>
            <PortfolioFilter applied={floorFilter} onApply={setFloorFilter} />
          </div>
        </div>

        <div className={styles.pickerRow}>
          <div className={styles.catTabs}>
            {CATEGORIES.map((c) => (
              <button key={c.id} className={[styles.catTab, category === c.id ? styles.catTabActive : ''].join(' ')} onClick={() => setCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <p className={styles.hint}>
          {resourceId
            ? 'Click a time on the calendar, or drag across hours and days, to pick a window — the space is picked in the form.'
            : 'No bookable desks or rooms yet — mark desks as hot desks or spaces as reservable in Facilio, then book them here.'}
        </p>

        <div className={styles.calToolbar}>
          <button className={[styles.myBookings, myBookingsInRange.length ? styles.myBookingsActive : ''].join(' ')} onClick={() => setMyOpen(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            My bookings
            <span className={styles.myBadge}>{myBookingsInRange.length}</span>
          </button>
          <div className={styles.viewSeg}>
            {(['day', 'week', 'month'] as CalView[]).map((v) => (
              <button key={v} className={[styles.viewBtn, calView === v ? styles.viewBtnActive : ''].join(' ')} onClick={() => setCalView(v)}>
                {v === 'day' ? 'Day' : v === 'week' ? 'Week' : 'Month'}
              </button>
            ))}
          </div>
          <div className={styles.navGroup}>
            <button className={styles.navBtn} onClick={() => stepFocus(-1)} title="Previous">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <button className={styles.todayBtn} onClick={() => setFocusDate(orgTodayISO())}>Today</button>
            <button className={styles.navBtn} onClick={() => stepFocus(1)} title="Next">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
          <div className={styles.rangeLabel}>{rangeLabel}</div>
        </div>

        <div className={styles.calArea}>
          {calLoading && (
            <div className={styles.calLoading}>
              <span className={styles.calSpinner} />
              Loading bookings…
            </div>
          )}
          {calView === 'month' ? (
            <MonthGrid
              dates={visibleDates}
              monthIso={focusDate}
              bookingsFor={bookingsFor}
              onPickDay={(d) => {
                setFocusDate(d);
                setCalView('day');
              }}
            />
          ) : (
            <CalendarGrid dates={visibleDates} bookingsFor={bookingsFor} myId={state.bookBy} onCreate={openForm} onPreview={(date, ids) => setPreview({ date, ids })} contactNameOf={(id) => contactName(state, id)} />
          )}
        </div>

        {myOpen && (
          <Modal onClose={() => setMyOpen(false)} width={520}>
            <ModalHeader title="My bookings" subtitle={`${myBookingsInRange.length} in the visible range`} onClose={() => setMyOpen(false)} />
            <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '58vh', overflowY: 'auto' }}>
              {myBookingsInRange.length === 0 && (
                <p style={{ font: '400 13px/1.5 var(--font-sans)', color: 'var(--ink-500)', margin: 0 }}>No bookings in the visible date range — switch to Week or Month to widen it.</p>
              )}
              {[...myBookingsInRange].sort((a, b) => (a.date === b.date ? a.start - b.start : a.date.localeCompare(b.date))).map((b) => bookingCard(b, { titleAsJump: true, showDate: true }))}
            </div>
          </Modal>
        )}

        {preview && (
          <Modal onClose={() => setPreview(null)} width={480}>
            <ModalHeader
              title={`Bookings · ${fmtDay(preview.date)}`}
              subtitle={`${(bookingsByDate[preview.date] ?? []).filter((b) => preview.ids.includes(b.id)).length} booking(s)`}
              onClose={() => setPreview(null)}
            />
            <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '58vh', overflowY: 'auto' }}>
              {(bookingsByDate[preview.date] ?? []).filter((b) => preview.ids.includes(b.id)).map((b) => bookingCard(b, { onCancelled: () => setPreview(null) }))}
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}

/** A day's bookings in overlap clusters: sorted by start, a booking joins the cluster it starts inside. */
function clusterBookings(list: Booking[]): Booking[][] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters: Booking[][] = [];
  let clusterEnd = -1;
  for (const b of sorted) {
    if (clusters.length && b.start < clusterEnd) {
      clusters[clusters.length - 1].push(b);
      clusterEnd = Math.max(clusterEnd, b.end);
    } else {
      clusters.push([b]);
      clusterEnd = b.end;
    }
  }
  return clusters;
}

interface CalendarGridProps {
  dates: string[];
  bookingsFor: (date: string) => Booking[];
  myId: string;
  onCreate: (date: string, start: number, end: number, endDate?: string) => void;
  onPreview: (date: string, ids: string[]) => void;
  contactNameOf: (id: string) => string;
}

function CalendarGrid({ dates, bookingsFor, myId, onCreate, onPreview, contactNameOf }: CalendarGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ date: string; from: number; to: number; endDate?: string } | null>(null);
  const dragRef = useRef<{
    date: string;
    colTop: number;
    anchor: number;
    from: number;
    to: number;
    /** Every day column's x-range, captured on mousedown, so the drag can cross into them. */
    cols: { date: string; left: number; right: number }[];
    anchorDate: string;
    endDate: string;
  } | null>(null);
  // Live "now", once a minute, so the current-time line stays put while the view sits open.
  const [now, setNow] = useState(nowMinutes());
  useEffect(() => {
    const t = setInterval(() => setNow(nowMinutes()), 60_000);
    return () => clearInterval(t);
  }, []);

  const todayIso = orgTodayISO();
  const gridHeight = ((DAY_END - DAY_START) / 60) * PX_PER_HOUR;

  // Open scrolled to the working day.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (7 * 60 - DAY_START) * PX_PER_MIN);
  }, []);

  /** The half-hour under a y-position. */
  function slotAt(colTop: number, clientY: number): number {
    const raw = (clientY - colTop) / PX_PER_MIN + DAY_START;
    return Math.max(DAY_START, Math.min(DAY_END - SNAP, Math.floor(raw / SNAP) * SNAP));
  }

  function onColMouseDown(date: string, e: ReactMouseEvent) {
    if (e.button !== 0) return;
    const colEl = e.currentTarget as HTMLElement;
    const colTop = colEl.getBoundingClientRect().top;
    const cols = Array.from(colEl.parentElement?.querySelectorAll<HTMLElement>('[data-daycol]') ?? []).map((el) => {
      const r = el.getBoundingClientRect();
      return { date: el.dataset.daycol as string, left: r.left, right: r.right };
    });
    const from = slotAt(colTop, e.clientY);
    dragRef.current = { date, colTop, anchor: from, from, to: from + SNAP, cols, anchorDate: date, endDate: date };
    setDrag({ date, from, to: from + SNAP });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
  }
  function onDragMove(e: MouseEvent) {
    const d = dragRef.current;
    if (!d) return;
    // The selection stretches from where the drag started, either way, and into other days: the
    // earlier edge is the start, the later the end. No cap — the window is as long as the drag.
    const s = slotAt(d.colTop, e.clientY);
    const overDate =
      d.cols.find((c) => e.clientX >= c.left && e.clientX < c.right)?.date ??
      (d.cols.length && e.clientX < d.cols[0].left ? d.cols[0].date : d.cols[d.cols.length - 1]?.date) ??
      d.anchorDate;
    if (overDate !== d.anchorDate) {
      const forward = overDate > d.anchorDate;
      d.date = forward ? d.anchorDate : overDate;
      d.endDate = forward ? overDate : d.anchorDate;
      d.from = forward ? d.anchor : s;
      d.to = forward ? s + SNAP : d.anchor + SNAP;
      setDrag({ date: d.date, from: d.from, to: d.to, endDate: d.endDate });
      return;
    }
    d.date = d.anchorDate;
    d.endDate = d.anchorDate;
    d.from = Math.min(d.anchor, s);
    d.to = Math.max(d.anchor, s) + SNAP;
    setDrag({ date: d.date, from: d.from, to: d.to });
  }
  function onDragUp() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    // The create runs outside any setState updater: StrictMode double-invokes updaters, which
    // would open the form twice. A plain click books one half-hour (the form confirms first).
    if (d) onCreate(d.date, d.from, d.to, d.endDate !== d.date ? d.endDate : undefined);
  }

  return (
    <div className={styles.calWrap}>
      <div className={styles.dayHeaderRow}>
        <div className={styles.gutterHead} />
        {dates.map((d) => {
          const dt = parseISO(d);
          return (
            <div key={d} className={[styles.dayHead, d === todayIso ? styles.dayHeadToday : ''].join(' ')}>
              {DAY_ABBR[dt.getDay()]} {shortDate(d)}
            </div>
          );
        })}
      </div>
      <div className={styles.calScroll} ref={scrollRef}>
        <div className={styles.calBody} style={{ height: gridHeight }}>
          <div className={styles.gutter}>
            {Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => {
              const min = DAY_START + i * 60;
              return (
                <div key={min} className={styles.hourLabel} style={{ top: i * PX_PER_HOUR }}>
                  {formatHour(min)}
                </div>
              );
            })}
          </div>
          {dates.map((d) => {
            const isToday = d === todayIso;
            const blocks = bookingsFor(d);
            const inDrag = drag && (drag.endDate && drag.endDate !== drag.date ? d >= drag.date && d <= drag.endDate : drag.date === d);
            return (
              <div key={d} data-daycol={d} className={styles.dayCol} onMouseDown={(e) => onColMouseDown(d, e)}>
                {Array.from({ length: (DAY_END - DAY_START) / 60 }, (_, i) => (
                  <div key={i} className={styles.hourCell} style={{ top: (i + 1) * PX_PER_HOUR }} />
                ))}
                {clusterBookings(blocks).map((cluster) => {
                  const cStart = Math.min(...cluster.map((b) => b.start));
                  const cEnd = Math.max(...cluster.map((b) => b.end));
                  const top = (Math.max(DAY_START, cStart) - DAY_START) * PX_PER_MIN;
                  const height = Math.max(16, (Math.min(DAY_END, cEnd) - Math.max(DAY_START, cStart)) * PX_PER_MIN);
                  if (cluster.length > 1) {
                    // Overlapping bookings collapse into one count block; clicking previews them all.
                    return (
                      <button
                        key={cluster[0].id}
                        type="button"
                        className={[styles.block, styles.blockOther].join(' ')}
                        style={{ top, height, cursor: 'pointer', textAlign: 'left' }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => onPreview(d, cluster.map((b) => b.id))}
                        data-tip={`${fmtTime(cStart)} – ${fmtTime(cEnd)} · ${cluster.length} overlapping bookings — click to preview`}
                        data-tip-pos="top"
                      >
                        <div className={styles.blockTime}>{fmtTime(cStart)} - {fmtTime(cEnd)}</div>
                        <div className={styles.blockName}>{cluster.length} bookings</div>
                      </button>
                    );
                  }
                  const b = cluster[0];
                  const mine = b.by === myId;
                  return (
                    <div
                      key={b.id}
                      className={[styles.block, mine ? styles.blockMine : styles.blockOther].join(' ')}
                      // Pending approval reads amber, so a request looks different from a confirmed booking.
                      style={{ top, height, cursor: 'pointer', ...(b.approvalPending ? { background: 'var(--warning-050)', borderColor: 'var(--warning-700)', color: 'var(--warning-700)' } : {}) }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => onPreview(d, [b.id])}
                      data-tip={`${fmtTime(b.start)} – ${fmtTime(b.end)} · ${mine ? 'Your booking' : `Booked by ${contactNameOf(b.by) || 'someone'}`}${b.approvalPending ? ' · pending approval' : ''} — click to preview`}
                      data-tip-pos="top"
                    >
                      <div className={styles.blockTime}>{fmtTime(b.start)} - {fmtTime(b.end)}</div>
                      <div className={styles.blockName}>{mine ? 'Your booking' : contactNameOf(b.by) || 'Booked'}</div>
                    </div>
                  );
                })}
                {inDrag && drag && (
                  <div
                    className={styles.selBlock}
                    style={{
                      // A multi-day selection paints from its start on day one, whole days between,
                      // and up to the end on the last day.
                      top: ((drag.endDate && d > drag.date ? DAY_START : Math.min(drag.from, drag.to)) - DAY_START) * PX_PER_MIN,
                      height: Math.max(
                        2,
                        (drag.endDate && drag.endDate !== drag.date ? (d === drag.endDate ? drag.to : DAY_END) - (d === drag.date ? drag.from : DAY_START) : Math.abs(drag.to - drag.from)) * PX_PER_MIN
                      ),
                    }}
                  >
                    <span className={styles.selLabel}>
                      {drag.endDate && drag.endDate !== drag.date ? `${shortDate(drag.date)} ${fmtTime(drag.from)} – ${shortDate(drag.endDate)} ${fmtTime(drag.to)}` : `${fmtTime(Math.min(drag.from, drag.to))} - ${fmtTime(Math.max(drag.from, drag.to))}`}
                    </span>
                  </div>
                )}
                {isToday && (
                  <div className={styles.nowLine} style={{ top: (now - DAY_START) * PX_PER_MIN }}>
                    <span className={styles.nowDot} />
                    <span className={styles.nowLabel}>{fmtTime(now)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatHour(min: number): string {
  // 24:00 is midnight again — "12am", not "12pm".
  const h = Math.floor(min / 60) % 24;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

function MonthGrid({ dates, monthIso, bookingsFor, onPickDay }: { dates: string[]; monthIso: string; bookingsFor: (date: string) => Booking[]; onPickDay: (date: string) => void }) {
  const month = parseISO(monthIso).getMonth();
  const todayIso = orgTodayISO();
  return (
    <div className={styles.monthWrap}>
      <div className={styles.monthHead}>
        {DAY_ABBR.map((d) => (
          <div key={d} className={styles.monthHeadCell}>{d}</div>
        ))}
      </div>
      <div className={styles.monthGrid}>
        {dates.map((d) => {
          const dt = parseISO(d);
          const inMonth = dt.getMonth() === month;
          const blocks = bookingsFor(d);
          return (
            <button key={d} className={[styles.monthCell, inMonth ? '' : styles.monthCellDim].join(' ')} onClick={() => onPickDay(d)}>
              <span className={[styles.monthDate, d === todayIso ? styles.monthDateToday : ''].join(' ')}>{dt.getDate()}</span>
              <div className={styles.monthBars}>
                {[...blocks]
                  .sort((a, b) => a.start - b.start)
                  .slice(0, 3)
                  .map((b) => (
                    <span key={b.id} className={styles.monthBar}>
                      {fmtTime(b.start)}
                    </span>
                  ))}
                {blocks.length > 3 && <span className={styles.monthMore}>+{blocks.length - 3} more</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────── Portfolio filter ─────────────────────────── */

/**
 * "Filter": a popover checkbox tree (Site → Building → Floor). Buildings and floors load on
 * expand through the same data-source reads the portfolio tab uses; a search box narrows the
 * loaded rows. Apply hands the chosen floors up (the calendar re-reads with them in the request);
 * Reset clears everything.
 */
function PortfolioFilter({ applied, onApply }: { applied: { id: string; name: string }[]; onApply: (floors: { id: string; name: string }[]) => void }) {
  const { state } = useFloorplanData();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  /** Draft while the popover is open — floorId → chip label. */
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [buildingsBySite, setBuildingsBySite] = useState<Record<string, Building[]>>({});
  const [floorsByBuilding, setFloorsByBuilding] = useState<Record<string, Floor[]>>({});
  const [openSites, setOpenSites] = useState<Set<string>>(new Set());
  const [openBuildings, setOpenBuildings] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // The portfolio in state may already carry children; a cached [] means "loaded, none", null "not yet".
  const buildingsOf = (site: Site): Building[] | null => (site.buildings?.length ? site.buildings : buildingsBySite[site.id] ?? null);
  const floorsOf = (b: Building): Floor[] | null => (b.floors?.length ? b.floors : floorsByBuilding[b.id] ?? null);

  const loadBuildings = async (site: Site): Promise<Building[]> => {
    const have = buildingsOf(site);
    if (have) return have;
    const list = await dataSource.getBuildings(site.id).catch(() => [] as Building[]);
    setBuildingsBySite((m) => ({ ...m, [site.id]: list }));
    return list;
  };
  const loadFloors = async (b: Building): Promise<Floor[]> => {
    const have = floorsOf(b);
    if (have) return have;
    const list = await dataSource.getFloors(b.id).catch(() => [] as Floor[]);
    setFloorsByBuilding((m) => ({ ...m, [b.id]: list }));
    return list;
  };

  // Several buildings share floor names ("Floor 1"), so a chip carries the building too.
  const chipLabel = (b: Building, f: Floor) => `${b.name} · ${f.name}`;

  const setAllOrNone = (entries: { id: string; name: string }[]) =>
    setDraft((d) => {
      const n = new Map(d);
      const allSelected = entries.length > 0 && entries.every((e) => n.has(e.id));
      if (allSelected) entries.forEach((e) => n.delete(e.id));
      else entries.forEach((e) => n.set(e.id, e.name));
      return n;
    });

  const toggleFloor = (b: Building, f: Floor) =>
    setDraft((d) => {
      const n = new Map(d);
      if (n.has(f.id)) n.delete(f.id);
      else n.set(f.id, chipLabel(b, f));
      return n;
    });
  const toggleBuilding = async (b: Building) => {
    setOpenBuildings((s) => new Set(s).add(b.id));
    setAllOrNone((await loadFloors(b)).map((f) => ({ id: f.id, name: chipLabel(b, f) })));
  };
  const toggleSite = async (site: Site) => {
    setOpenSites((s) => new Set(s).add(site.id));
    const bs = await loadBuildings(site);
    setOpenBuildings((s) => new Set([...s, ...bs.map((x) => x.id)]));
    const entries = await Promise.all(bs.map(async (b) => (await loadFloors(b)).map((f) => ({ id: f.id, name: chipLabel(b, f) }))));
    setAllOrNone(entries.flat());
  };

  const q = search.trim().toLowerCase();
  const hit = (name: string) => name.toLowerCase().includes(q);
  const siteVisible = (site: Site) => !q || hit(site.name) || (buildingsOf(site) ?? []).some((b) => hit(b.name) || (floorsOf(b) ?? []).some((f) => hit(f.name)));

  const openPopover = () => {
    if (!open) setDraft(new Map(applied.map((f) => [f.id, f.name])));
    setOpen((o) => !o);
  };
  const reset = () => {
    setDraft(new Map());
    setSearch('');
    setOpen(false);
    onApply([]);
  };
  const apply = () => {
    setOpen(false);
    onApply(Array.from(draft, ([id, name]) => ({ id, name })));
  };

  const checkboxRef = (some: boolean, all: boolean) => (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = some && !all;
  };

  return (
    <div className={styles.filterWrap} ref={wrapRef}>
      <button className={[styles.myBookings, applied.length ? styles.myBookingsActive : ''].join(' ')} onClick={openPopover}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
        Filter
        {applied.length > 0 && <span className={styles.myBadge}>{applied.length}</span>}
      </button>
      {applied.length > 0 && (
        // The first two active filters render inline; the rest collapse into a +N pill that opens
        // the panel, where every one can be removed.
        <div className={styles.filterChips}>
          {applied.slice(0, CHIP_LIMIT).map((f) => (
            <span key={f.id} className={styles.filterChip} data-tip={f.name} data-tip-align="end" data-tip-pos="top">
              <span className={styles.chipLabel}>{f.name}</span>
              <button className={styles.chipX} title="Remove" onClick={() => onApply(applied.filter((x) => x.id !== f.id))}>
                ×
              </button>
            </span>
          ))}
          {applied.length > CHIP_LIMIT && (
            <button type="button" className={styles.chipMore} title={`${applied.length - CHIP_LIMIT} more — open the filter to manage them`} onClick={openPopover}>
              +{applied.length - CHIP_LIMIT}
            </button>
          )}
        </div>
      )}
      {open && (
        <div className={styles.filterPop}>
          {draft.size > 0 && (
            <div className={styles.activeBox}>
              <div className={styles.activeHead}>
                <span>
                  Active filters <b>{draft.size}</b>
                </span>
                <button type="button" className={styles.clearAll} onClick={() => setDraft(new Map())}>
                  Clear all
                </button>
              </div>
              <div className={styles.activeList}>
                {Array.from(draft, ([id, name]) => (
                  <span key={id} className={styles.filterChip} data-tip={name}>
                    <span className={styles.chipLabel}>{name}</span>
                    <button
                      className={styles.chipX}
                      title="Remove"
                      onClick={() =>
                        setDraft((d) => {
                          const n = new Map(d);
                          n.delete(id);
                          return n;
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <input className={styles.filterSearch} placeholder="Search sites, buildings, floors…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          <div className={styles.filterTree}>
            {state.portfolio.filter(siteVisible).map((site) => {
              const expanded = q ? true : openSites.has(site.id);
              const bs = buildingsOf(site);
              const siteFloors = (bs ?? []).flatMap((b) => floorsOf(b) ?? []);
              const siteSel = siteFloors.filter((f) => draft.has(f.id)).length;
              const siteAll = siteFloors.length > 0 && siteSel === siteFloors.length;
              return (
                <div key={site.id}>
                  <label className={styles.filterRow}>
                    <input type="checkbox" checked={siteAll} ref={checkboxRef(siteSel > 0, siteAll)} onChange={() => void toggleSite(site)} />
                    <span className={styles.filterName}>{site.name}</span>
                    <button
                      className={styles.chevBtn}
                      onClick={(e) => {
                        e.preventDefault();
                        setOpenSites((s) => {
                          const n = new Set(s);
                          if (n.has(site.id)) n.delete(site.id);
                          else n.add(site.id);
                          return n;
                        });
                        void loadBuildings(site);
                      }}
                    >
                      {expanded ? '▾' : '▸'}
                    </button>
                  </label>
                  {expanded && bs === null && <div className={styles.filterLoading}>Loading…</div>}
                  {expanded &&
                    (bs ?? [])
                      .filter((b) => !q || hit(site.name) || hit(b.name) || (floorsOf(b) ?? []).some((f) => hit(f.name)))
                      .map((b) => {
                        const bExpanded = q ? true : openBuildings.has(b.id);
                        const fls = floorsOf(b);
                        const bSel = (fls ?? []).filter((f) => draft.has(f.id)).length;
                        const bAll = (fls ?? []).length > 0 && bSel === (fls ?? []).length;
                        return (
                          <div key={b.id}>
                            <label className={[styles.filterRow, styles.filterRowL2].join(' ')}>
                              <input type="checkbox" checked={bAll} ref={checkboxRef(bSel > 0, bAll)} onChange={() => void toggleBuilding(b)} />
                              <span className={styles.filterName}>{b.name}</span>
                              <button
                                className={styles.chevBtn}
                                onClick={(e) => {
                                  e.preventDefault();
                                  setOpenBuildings((s) => {
                                    const n = new Set(s);
                                    if (n.has(b.id)) n.delete(b.id);
                                    else n.add(b.id);
                                    return n;
                                  });
                                  void loadFloors(b);
                                }}
                              >
                                {bExpanded ? '▾' : '▸'}
                              </button>
                            </label>
                            {bExpanded && fls === null && <div className={styles.filterLoading}>Loading…</div>}
                            {bExpanded &&
                              (fls ?? [])
                                .filter((f) => !q || hit(site.name) || hit(b.name) || hit(f.name))
                                .map((f) => (
                                  <label key={f.id} className={[styles.filterRow, styles.filterRowL3].join(' ')}>
                                    <input type="checkbox" checked={draft.has(f.id)} onChange={() => toggleFloor(b, f)} />
                                    <span className={styles.filterName}>{f.name}</span>
                                  </label>
                                ))}
                          </div>
                        );
                      })}
                </div>
              );
            })}
            {state.portfolio.filter(siteVisible).length === 0 && <div className={styles.filterLoading}>No matches</div>}
          </div>
          <div className={styles.filterFoot}>
            <button className={styles.filterReset} onClick={reset}>
              ⟲ Reset filter
            </button>
            <button className={styles.filterApply} onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
