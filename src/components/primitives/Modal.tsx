import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import styles from './Modal.module.css';

interface ModalProps {
  onClose: () => void;
  width?: number;
  children: ReactNode;
}

/**
 * Portaled to <body>, always.
 *
 * The backdrop is `position: fixed`, and a fixed element resolves against the nearest TRANSFORMED
 * ancestor rather than the viewport. Opened from inside the unit popover — a 214px card carrying
 * `transform: translate(-50%, 0)` — the whole dialog was being laid out inside that card, so a
 * 560px picker rendered at about 330px with every name truncated. Rendering outside the tree puts
 * it back on the viewport, whatever it was opened from.
 */
export function Modal({ onClose, width = 560, children }: ModalProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.card} style={{ width, maxWidth: 'min(100%, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function ModalHeader({ title, subtitle, onClose }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void }) {
  return (
    <div className={styles.header}>
      <div>
        <h3 className={styles.title}>{title}</h3>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </div>
      <button className={styles.close} data-tip="Close" onClick={onClose}>
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
