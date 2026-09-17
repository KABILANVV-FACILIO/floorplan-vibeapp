import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { orgNow } from '../../lib/orgTime';
import { Calendar, parseISO } from './Calendar';

/**
 * App-wide DATE PICKER: a button showing the friendly date, and a popup carrying the app's one
 * `Calendar` (plus HH/MM columns in datetime mode). min/max days render disabled, so the booking
 * window (e.g. "today .. one week") is VISIBLE instead of silently rejected — the browser-default
 * picker communicated none of that, which is why every form that still used one now uses this.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  fullWidth,
  minutes,
  onMinutesChange,
  minuteStep = 1,
  minMinutes,
  maxMinutes,
  disabled,
  'aria-label': ariaLabel,
}: {
  /** ISO yyyy-mm-dd */
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  fullWidth?: boolean;
  /**
   * DATETIME mode (the org's own start/end fields are datetime): pass minutes-from-midnight and
   * a setter to get HH / MM columns beside the calendar, like the native picker. Omit for a
   * plain date picker.
   */
  minutes?: number;
  onMinutesChange?: (m: number) => void;
  /** MM column step (1 = every minute, like the native picker). */
  minuteStep?: number;
  /** Earliest selectable minute ON the min date (org clock) — past times can't be picked. */
  minMinutes?: number;
  maxMinutes?: number;
  /** Read-only display — a DERIVED value (e.g. a room's end = start + 2h) can't be edited. */
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const isDateTime = minutes != null && !!onMinutesChange;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // FLOATING placement (portal + fixed): inside a modal/panel an absolutely-positioned popup
  // pushed the form down / clipped against the scroll edge — this overlays instead, flipping
  // above the trigger when the viewport bottom is close.
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const POP_H = 330;
      const up = window.innerHeight - r.bottom < POP_H && r.top > POP_H;
      setPos({ left: Math.min(Math.max(r.left, 8), window.innerWidth - 260), top: up ? r.top - 6 : r.bottom + 6, up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const inRange = (iso: string) => (!min || iso >= min) && (!max || iso <= max);

  const display = parseISO(value)
    ? `${parseISO(value)!.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${isDateTime ? ` · ${fmt12(minutes!)}` : ''}`
    : 'Pick a date';
  // On the earliest allowed date, times before `minMinutes` (org clock "now") are disabled.
  const minuteAllowed = (m: number) =>
    !(minMinutes != null && value === min && m < minMinutes) && !(maxMinutes != null && value === max && m > maxMinutes);

  return (
    <div ref={rootRef} style={{ position: 'relative', ...(fullWidth ? { width: '100%' } : {}) }}>
      <button
        type="button"
        aria-label={ariaLabel ?? 'Date'}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          boxSizing: 'border-box',
          padding: '9px 11px',
          borderRadius: 8,
          border: `1.5px solid ${open ? 'var(--blue-500)' : 'var(--ink-200)'}`,
          background: disabled ? 'var(--ink-050)' : '#fff',
          font: '500 13.5px var(--font-sans)',
          color: disabled ? 'var(--ink-600)' : 'var(--ink-900)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
        }}
      >
        <span>{display}</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            zIndex: 320, // above the Modal overlay (200) — the popup opened BEHIND it and read as a dead button
            top: pos.top,
            left: pos.left,
            transform: pos.up ? 'translateY(-100%)' : undefined,
            minWidth: 252,
            background: '#fff',
            border: '1px solid var(--ink-200)',
            borderRadius: 10,
            boxShadow: '0 10px 28px rgba(28,39,51,0.16)',
            padding: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 10 }}>
            {/* The app's one calendar. In datetime mode the popup stays open after a day is
                picked, because the time columns beside it still need answering. */}
            <Calendar
              value={value}
              min={min}
              max={max}
              showRange={false}
              onChange={(iso) => {
                onChange(iso);
                if (!isDateTime) setOpen(false);
              }}
            />
          {isDateTime && (
            // HH / MM columns, same shape as the org's native datetime picker.
            <div style={{ display: 'flex', gap: 6, borderLeft: '1px solid var(--ink-100)', paddingLeft: 10 }}>
              {(
                [
                  { key: 'HH', values: Array.from({ length: 24 }, (_, h) => h), current: Math.floor(minutes! / 60), set: (h: number) => onMinutesChange!(h * 60 + (minutes! % 60)) },
                  { key: 'MM', values: Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep), current: minutes! % 60, set: (mm: number) => onMinutesChange!(Math.floor(minutes! / 60) * 60 + mm) },
                ] as const
              ).map((col) => (
                <div key={col.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ font: '600 10.5px var(--font-sans)', color: 'var(--ink-400)', padding: '2px 0 4px' }}>{col.key}</div>
                  <div style={{ maxHeight: 176, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 2 }}>
                    {col.values.map((v) => {
                      const cand = col.key === 'HH' ? v * 60 + (minutes! % 60) : Math.floor(minutes! / 60) * 60 + v;
                      const ok = minuteAllowed(cand);
                      const sel = col.current === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          disabled={!ok}
                          onClick={() => col.set(v)}
                          style={{
                            width: 40,
                            padding: '4px 0',
                            borderRadius: 6,
                            border: '1px solid transparent',
                            background: sel ? 'var(--blue-025, #eef4fd)' : 'transparent',
                            color: sel ? 'var(--blue-600)' : ok ? 'var(--ink-800)' : 'var(--ink-300)',
                            font: `${sel ? 600 : 500} 12.5px var(--font-sans)`,
                            cursor: ok ? 'pointer' : 'not-allowed',
                          }}
                        >
                          {String(v).padStart(2, '0')}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>
          {isDateTime && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--ink-100)', marginTop: 8, paddingTop: 8 }}>
              <button
                type="button"
                onClick={() => {
                  const now = orgNow();
                  // "Now" lands on the NEXT WHOLE SLOT, never the raw clock minute (requested:
                  // 10:51 -> 11:00, 11:01 -> 11:30) — the MM column only offers the grid, so a
                  // raw minute produced a time the user could not have picked by hand. Rolling
                  // past the end of the day would change the DATE, so the last slot is the cap.
                  const step = Math.max(1, minuteStep);
                  const upper = Math.min(maxMinutes ?? 1440 - step, 1440 - step);
                  const snapped = Math.min(upper, Math.max(minMinutes ?? 0, Math.ceil(now.minutes / step) * step));
                  if (inRange(now.dateISO)) onChange(now.dateISO);
                  onMinutesChange!(snapped);
                }}
                style={{ border: 'none', background: 'none', color: 'var(--blue-600)', font: '600 12.5px var(--font-sans)', cursor: 'pointer', padding: 0 }}
              >
                Now
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{ border: 'none', background: 'var(--blue-500)', color: '#fff', borderRadius: 7, padding: '6px 14px', font: '600 12.5px var(--font-sans)', cursor: 'pointer' }}
              >
                Done
              </button>
            </div>
          )}
          {(min || max) && (
            <div style={{ marginTop: 8, font: '500 11px var(--font-sans)', color: 'var(--ink-500)', textAlign: 'center' }}>
              {min === max ? 'Today only' : `Bookable ${min ? fmtShort(min) : '…'} – ${max ? fmtShort(max) : '…'}`}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

/** 12-hour label for the trigger — AM/PM everywhere, never railway time. */
function fmt12(m: number): string {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${String(h % 12 || 12)}:${mm} ${ampm}`;
}
function fmtShort(iso: string): string {
  const d = parseISO(iso);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : iso;
}
