import { useFloorplanData } from '../../state/FloorplanContext';
import { orgNow } from '../../lib/orgTime';
import { useSheetDrag } from './useSheetDrag';
import { Calendar } from '../primitives/Calendar';
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
  const { state, actions } = useFloorplanData();
  const sheetRef = useSheetDrag(onClose, open);

  if (!open) return null;

  // The ORG's today, as everywhere else in the app — not the phone's clock, which can be a day off
  // from the facility's.
  const todayIso = orgNow().dateISO;

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
        <button type="button" className={styles.todayBtn} onClick={() => pick(todayIso)}>
          Jump to today
        </button>
      </div>
    </>
  );
}
