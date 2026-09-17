import { useFloorplan } from '../../state/FloorplanContext';
import { myAssignedUnit } from '../../state/selectors';
import styles from './Toolbar.module.css';

export function Toolbar({ leftPad, rightPad }: { leftPad: number; rightPad: number }) {
  const { state, actions } = useFloorplan();
  const myUnit = myAssignedUnit(state);
  // Mock tier derives "my desk" from local assignments; the real backend provides it via
  // servicePortalHome (state.myDesk). Either one lights the button up.
  const hasMyDesk = !!myUnit || !!state.myDesk;

  function onMyDesk() {
    if (myUnit) actions.focusUnit(myUnit.id, state.stage.w, state.stage.h, { select: false });
    else actions.locateMyDesk(state.stage.w, state.stage.h);
  }

  return (
    <div className={styles.wrap} style={{ paddingLeft: leftPad, paddingRight: rightPad }}>
      <div className={styles.pill}>
        <div className={styles.segment}>
          <button className={[styles.segBtn, state.mode === 'assign' ? styles.segBtnActive : ''].join(' ')} onClick={() => actions.setMode('assign')}>
            Assignment
          </button>
          <button className={[styles.segBtn, state.mode === 'book' ? styles.segBtnActive : ''].join(' ')} onClick={() => actions.setMode('book')}>
            Booking
          </button>
        </div>

        <button
          className={[styles.editBtn, state.mode === 'edit' ? styles.editBtnActive : ''].join(' ')}
          data-tip={state.mode === 'edit' ? 'Exit edit mode' : 'Edit floorplan (admin)'}
          onClick={actions.toggleEdit}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
          Edit
        </button>

        {/* Personal wayfinding has no place while editing the plan itself. */}
        {hasMyDesk && state.mode !== 'edit' && (
          <button className={styles.myDesk} data-tip="Locate my desk" onClick={onMyDesk}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              <circle cx="12" cy="12" r="4" />
            </svg>
            My desk
          </button>
        )}

        {/* PRINT the floor as the sheet designed for it — the title block, a card per module, the
            occupancy legend and the plan itself (see components/print/PrintSheet). The sheet is
            already in the page; this only opens the print dialog, so Cmd+P produces the same thing.
            Editing the plan is not a state you print from. */}
        {state.mode !== 'edit' && (
          <button className={styles.iconToggle} data-tip="Print this floor" aria-label="Print this floor" onClick={() => window.print()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9V3h12v6" />
              <rect x="4" y="9" width="16" height="8" rx="2" />
              <path d="M8 17h8v4H8z" />
            </svg>
          </button>
        )}

        {/* REFRESH the floor already on screen — plan image, desks/rooms/stalls, who holds them and
            the day's bookings. Never re-resolves WHICH floor, so it can't move you, and it leaves
            the camera alone so zoom and pan survive. */}
        <button
          className={styles.iconToggle}
          data-tip={state.refreshing ? 'Refreshing…' : 'Refresh this floor'}
          aria-label="Refresh this floor"
          disabled={state.refreshing}
          onClick={() => void actions.refreshFloor()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={state.refreshing ? { animation: 'fp-spin 720ms linear infinite', color: 'var(--blue-600)' } : undefined}
          >
            <path d="M21 12a9 9 0 1 1-3.5-7.1" />
            <path d="M21 4v5h-5" />
          </svg>
        </button>

        <button
          className={[styles.iconToggle, state.panels.details.open ? styles.iconToggleActive : ''].join(' ')}
          data-tip="Toggle details panel"
          onClick={() => actions.togglePanelOpen('details')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
