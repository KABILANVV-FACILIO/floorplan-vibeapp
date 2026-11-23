import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import styles from './Picklist.module.css';

export interface PicklistOption<T extends string> {
  value: T;
  label: string;
  /** Secondary line under the label (e.g. "assignable, not bookable"). */
  description?: string;
  /** Optional status dot color (CSS value) shown before the label. */
  dot?: string;
}

interface PicklistProps<T extends string> {
  value: T | null;
  options: PicklistOption<T>[];
  onChange: (value: T) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  'aria-label'?: string;
}

/**
 * Facilio Design System single-select picklist (FDS gallery Canvas-2.dc.html → Selection).
 * A styled trigger + popover — NOT a native `<select>` — with an optional status dot, a rotating
 * chevron, and a checkmark on the chosen row. Closes on outside click via a full-viewport scrim.
 *
 * From the keyboard, as a select behaves: Arrow Down on the field opens it, the focus lands on the
 * chosen option, the arrow keys (and Home / End) move between options, Enter or Space picks one,
 * and Escape or Tab closes it. Escape stops here — it closes the list, not the panel or the plan
 * selection behind it.
 */
export function Picklist<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Select an option',
  disabled,
  fullWidth = true,
  'aria-label': ariaLabel,
}: PicklistProps<T>) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value) ?? null;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Onto the chosen option as the list opens (the first, with nothing chosen yet).
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open]);

  function choose(v: T) {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent) {
    if (disabled || open || e.key !== 'ArrowDown') return;
    e.preventDefault();
    setOpen(true);
  }

  function onMenuKeyDown(e: ReactKeyboardEvent) {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'Tab') {
      // The focus moves on; the list doesn't stay open behind it.
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      items[next]?.focus();
    }
  }

  return (
    <div className={[styles.wrap, fullWidth ? styles.fullWidth : ''].join(' ')}>
      {label && <div className={styles.label}>{label}</div>}
      {open && <div className={styles.scrim} onClick={() => setOpen(false)} />}
      <button
        ref={triggerRef}
        type="button"
        className={[styles.trigger, open ? styles.open : ''].join(' ')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.triggerText}>
          {selected ? (
            <>
              {selected.dot && <span className={styles.dot} style={{ background: selected.dot }} />}
              <span className={styles.value}>{selected.label}</span>
            </>
          ) : (
            <span className={styles.placeholder}>{placeholder}</span>
          )}
        </span>
        <svg
          className={[styles.chevron, open ? styles.up : ''].join(' ')}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} className={styles.menu} role="listbox" aria-label={ariaLabel ?? label} onKeyDown={onMenuKeyDown}>
          {options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={on}
                className={[styles.option, on ? styles.selected : ''].join(' ')}
                onClick={() => choose(o.value)}
              >
                {o.dot && <span className={styles.dot} style={{ background: o.dot }} />}
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{o.label}</span>
                  {o.description && <span className={styles.optionDesc}>{o.description}</span>}
                </span>
                {on && (
                  <svg className={styles.check} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
