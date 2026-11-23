import type { ReactNode } from 'react';
import { Modal, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';

/**
 * "Are you sure?" in the app's own dialog, for the actions a mis-click makes costly: Vacate takes
 * someone off a desk in Facilio, Cancel takes a booking off the org. Both used to act on one click,
 * and the one place that did ask used the browser's `confirm()`, which a sandboxed frame or a
 * WebView answers "no" to at once — so the action silently did nothing there.
 *
 * The focus starts on the way out (`cancelLabel`), as in DeleteConfirmModal, so a second stray
 * Enter or Space backs out rather than confirms. Escape, the X and the backdrop all back out too.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = true,
  disabled = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** What will happen, in a sentence or two. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** The confirm button reads red: the action takes something away. */
  danger?: boolean;
  /** The confirm button is unavailable — the record went busy on another surface meanwhile. */
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal onClose={onCancel} width={400}>
      <ModalHeader title={title} onClose={onCancel} />
      {children && <div style={{ margin: 0, padding: '14px 20px', font: '400 13px/1.5 var(--font-sans)', color: 'var(--ink-700)' }}>{children}</div>}
      <ModalFooter>
        <Button variant="secondary" onClick={onCancel} autoFocus>
          {cancelLabel}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={disabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
