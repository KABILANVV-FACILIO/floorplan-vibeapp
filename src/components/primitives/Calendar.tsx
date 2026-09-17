import { useEffect, useState } from 'react';
import { orgNow } from '../../lib/orgTime';
import styles from './Calendar.module.css';

/**
 * The app's month calendar — the ONE grid behind every date picker in the app.
 *
 * There were two: a grid inline-styled inside `DatePicker` (which nothing rendered) and a second
 * one inside the mobile sheet, each with its own month arithmetic and its own idea of what a
 * disabled day looks like. Meanwhile three forms still used the browser's `<input type="date">`,
 * so the app shipped three different calendars depending on where you clicked. This is the one
 * both pickers now render, and the native inputs were replaced with them.
 *
 * Presentational and controlled: it owns which month is on screen, and nothing else.
 */
export function Calendar({
  value,
  onChange,
  min,
  max,
  size = 'sm',
  showRange = true,
}: {
  /** Selected day, ISO yyyy-mm-dd. */
  value: string;
  onChange: (iso: string) => void;
  /** Earliest / latest selectable day, ISO. Days outside render disabled rather than missing, so
      the bookable window is VISIBLE instead of silently rejecting a click. */
  min?: string;
  max?: string;
  /** `lg` is the touch size used by the mobile sheet. */
  size?: 'sm' | 'lg';
  /** Show the "Bookable 3 Sep – 10 Sep" footnote when a window is set. */
  showRange?: boolean;
}) {
  const selected = parseISO(value) ?? new Date();
  const [view, setView] = useState({ year: selected.getFullYear(), month: selected.getMonth() });

  // Follow the value when it changes underneath us — picking "today" elsewhere, or reopening the
  // picker on a different date, must not leave the grid on the month it happened to be showing.
  useEffect(() => {
    const d = parseISO(value);
    if (d) setView({ year: d.getFullYear(), month: d.getMonth() });
  }, [value]);

  // The ORG's today, not the browser's — the app runs against an org clock that can be a day off
  // from the viewer's machine.
  const todayIso = orgNow().dateISO;
  const inRange = (iso: string) => (!min || iso >= min) && (!max || iso <= max);

  const days = monthGrid(view.year, view.month);
  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  // Hide an arrow that could only reach a month where every day is disabled.
  const prevOk = !min || toISO(new Date(view.year, view.month, 0)) >= min;
  const nextOk = !max || toISO(new Date(view.year, view.month + 1, 1)) <= max;

  function step(delta: number) {
    setView((v) => {
      const m = v.month + delta;
      return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
    });
  }

  return (
    <div className={[styles.cal, size === 'lg' ? styles.lg : ''].join(' ')}>
      <div className={styles.head}>
        <button type="button" className={styles.navBtn} disabled={!prevOk} onClick={() => step(-1)} aria-label="Previous month">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className={styles.monthLabel}>{monthLabel}</span>
        <button type="button" className={styles.navBtn} disabled={!nextOk} onClick={() => step(1)} aria-label="Next month">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      <div className={styles.grid} role="grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={i} className={styles.weekCell}>
            {d}
          </div>
        ))}
        {days.map((d) => {
          const iso = toISO(d);
          const ok = inRange(iso);
          const isSel = iso === value;
          const isToday = iso === todayIso;
          return (
            <button
              key={iso}
              type="button"
              disabled={!ok}
              aria-current={isSel ? 'date' : undefined}
              aria-label={d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              className={[
                styles.day,
                d.getMonth() === view.month ? '' : styles.dim,
                isSel ? styles.sel : '',
                isToday && !isSel ? styles.today : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onChange(iso)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {showRange && (min || max) && (
        <div className={styles.range}>{min === max ? 'Today only' : `Bookable ${min ? fmtShort(min) : '…'} – ${max ? fmtShort(max) : '…'}`}</div>
      )}
    </div>
  );
}

/** Six rows of seven, with the leading and trailing days of the sibling months. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseISO(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function fmtShort(iso: string): string {
  const d = parseISO(iso);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : iso;
}
