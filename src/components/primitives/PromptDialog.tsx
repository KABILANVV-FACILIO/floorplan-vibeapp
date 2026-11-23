import { useId, useState } from 'react';
import { Modal, ModalFooter, ModalHeader } from './Modal';
import { Button } from './Button';
import styles from './PromptDialog.module.css';

/**
 * Asks for a line of text in the app's own dialog — the comment a workflow step requires.
 *
 * This used to be the browser's `prompt()`. A sandboxed frame or a WebView (the Facilio host, the
 * Facilio Builds phone app) answers that with null at once, which read as "cancelled": the step
 * silently never ran. The text is handed over exactly as typed; the caller decides how it is sent.
 */
export function PromptDialog({
  title,
  label,
  confirmLabel = 'Submit',
  onSubmit,
  onCancel,
}: {
  title: string;
  /** The field's name, read out and shown above it. */
  label: string;
  confirmLabel?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  return (
    <Modal onClose={onCancel} width={440}>
      <ModalHeader title={title} onClose={onCancel} />
      <div className={styles.body}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <textarea id={id} className={styles.field} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onSubmit(text)}>
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
