import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import styles from './Modal.module.css';

interface ModalProps {
  onClose: () => void;
  width?: number;
  children: ReactNode;
}

/** The title's id, so the dialog can name itself after its header. */
const TitleIdContext = createContext<string | undefined>(undefined);

/**
 * Open dialogs, innermost last. Escape closes only the innermost one: a confirm opened over a
 * picker must not take the picker with it.
 */
const openStack: string[] = [];

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function tabbables(root: HTMLElement): HTMLElement[] {
  // `tabIndex >= 0` drops what the selectors can't: a field taken out of the tab order on purpose
  // (the upload dialog's hidden file input) is not somewhere Tab should land.
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true'
  );
}

/**
 * Portaled to <body>, always.
 *
 * The backdrop is `position: fixed`, and a fixed element resolves against the nearest TRANSFORMED
 * ancestor rather than the viewport. Opened from inside the unit popover — a 214px card carrying
 * `transform: translate(-50%, 0)` — the whole dialog was being laid out inside that card, so a
 * 560px picker rendered at about 330px with every name truncated. Rendering outside the tree puts
 * it back on the viewport, whatever it was opened from.
 *
 * And it behaves as a dialog for a keyboard: the focus moves into it when it opens (unless a field
 * inside already took it), Tab cycles within it, Escape closes it, and the focus goes back to
 * whatever had it before — the button that opened it, usually.
 */
export function Modal({ onClose, width = 560, children }: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const cardRef = useRef<HTMLDivElement>(null);
  // Read through a ref: callers pass a fresh arrow every render, and re-subscribing on each one
  // would reorder the stack.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Whoever had the focus when the dialog was asked for — read during the first render, because by
  // the time an effect runs a field inside may already have taken the focus (autoFocus is applied
  // as the dialog mounts), and the element that opened it would be lost.
  const [opener] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  /** The field inside that took the focus as the dialog mounted (autoFocus), if one did. */
  const initialFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openStack.push(id);
    const card = cardRef.current;
    if (card) {
      // A field inside may have focused itself already (autoFocus) — leave it there, and remember
      // it: a development build runs this effect twice, and the first cleanup hands the focus back
      // to the opener before the second run.
      const active = document.activeElement;
      if (active instanceof HTMLElement && card.contains(active)) initialFocusRef.current = active;
      else {
        const remembered = initialFocusRef.current;
        (remembered && remembered.isConnected && card.contains(remembered) ? remembered : (tabbables(card)[0] ?? card)).focus();
      }
    }

    // On the document, in the bubbling phase: an open dropdown inside the dialog closes itself on
    // Escape first and stops the key there (see Select, DatePicker). And it stops here, so the plan
    // behind the dialog never also reads it as "clear the selection".
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== id) return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = openStack.lastIndexOf(id);
      if (at >= 0) openStack.splice(at, 1);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [id, opener]);

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== 'Tab' || !cardRef.current) return;
    const items = tabbables(cardRef.current);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === cardRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={cardRef}
        className={styles.card}
        style={{ width, maxWidth: 'min(100%, 92vw)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <TitleIdContext.Provider value={titleId}>{children}</TitleIdContext.Provider>
      </div>
    </div>,
    document.body
  );
}

export function ModalHeader({ title, subtitle, onClose }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void }) {
  const titleId = useContext(TitleIdContext);
  return (
    <div className={styles.header}>
      <div>
        <h3 className={styles.title} id={titleId}>
          {title}
        </h3>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </div>
      <button className={styles.close} data-tip="Close" aria-label="Close" onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return <div className={styles.footer}>{children}</div>;
}
