import { useFloorplan } from '../../state/FloorplanContext';
import { useSheetDrag } from './useSheetDrag';
import { Calendar, toISO } from '../primitives/Calendar';
import styles from './MobileDatePicker.module.css';

/**
 * The date sheet on mobile: the app's own `Calendar` at touch size, in a drag-to-dismiss sheet.
 *
 * The month grid used to be written out again here, with its own month arithmetic and its own
 * day states — a second calendar that could drift from the one the desktop picker shows. The
 * sheet keeps what is genuinely mobile (the backdrop, the drag handle, "Jump to today"); the
 * calendar itself is the shared one.
 */
export function MobileDatePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useFloorplan();
  const sheetRef = useSheetDrag(onClose, open);

  if (!open) return null;

  const todayIso = toISO(new Date());

  function pick(iso: string) {
    actions.setDate(iso);
    onClose();
  }

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div ref={sheetRef} className={styles.sheet}>
        <div className={styles.handle} />
        <Calendar value={state.date} size="lg" onChange={pick} />
        <button className={styles.todayBtn} onClick={() => pick(todayIso)}>
          Jump to today
        </button>
      </div>
    </>
  );
}
