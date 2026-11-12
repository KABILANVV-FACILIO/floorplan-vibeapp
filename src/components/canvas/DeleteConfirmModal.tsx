import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';

/**
 * "Delete this?" for the Delete and Backspace keys on the plan.
 *
 * A key press is the one delete that can happen by accident — a stray Backspace with a desk
 * selected — and it used to take the desk off the plan at once, with nothing to say so first. The
 * Edit panel's own Delete button is a labelled red button the user aimed at; it needs no second ask.
 *
 * The focus starts on Cancel, so a second stray Enter or Space backs out rather than confirms.
 */
export function DeleteConfirmModal({ labels, onConfirm, onCancel }: { labels: string[]; onConfirm: () => void; onCancel: () => void }) {
  const one = labels.length === 1;
  const what = one ? labels[0] : `${labels.length} spaces`;
  return (
    <Modal onClose={onCancel} width={400}>
      <ModalHeader title={`Delete ${what}?`} onClose={onCancel} />
      <p style={{ margin: 0, padding: '14px 20px', font: '400 13px/1.5 var(--font-sans)', color: 'var(--ink-700)' }}>
        {one ? 'It comes off the plan.' : 'They come off the plan.'} A desk, locker, stall or org room goes back to the spaces waiting to be placed;
        an outline drawn here is removed. The org's floor-plan records don't change until you save, and Discard changes brings {one ? 'it' : 'them'}{' '}
        back.
      </p>
      <ModalFooter>
        <Button variant="secondary" onClick={onCancel} autoFocus>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Delete
        </Button>
      </ModalFooter>
    </Modal>
  );
}
