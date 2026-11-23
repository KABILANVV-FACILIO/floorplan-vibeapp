import { useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { contactName } from '../../state/selectors';
import type { Unit } from '../../lib/types';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { AssignEmployeeModal } from './AssignEmployeeModal';
import styles from './AssignPanel.module.css';

/**
 * The app's own assign/vacate, for a record whose module has no stateflow — or that has no org
 * record at all, as in the local/demo tier. Everywhere else these are the org's transitions, and
 * showing both would offer two buttons that write to different places.
 *
 * Picking the person happens in the same dialog the transitions open; the select that used to sit
 * here was a second, smaller people list that only this panel had. Vacate asks "are you sure?"
 * first, as the org's own Vacate does.
 */
export function LocalAssign({ unit }: { unit: Unit }) {
  const { state, actions } = useFloorplanData();
  const [picking, setPicking] = useState(false);
  const [vacating, setVacating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const holderId = state.assignments[unit.id];
  const assigned = !!holderId;
  const busy = state.busyUnitId === unit.id;

  async function vacate() {
    // Only the BUTTON's own spinner is local. Marking the record busy and announcing that it
    // changed both live in `actions.vacate`, so every other way of vacating — the mobile sheet,
    // a future surface — gets them too.
    setVacating(true);
    try {
      await actions.vacate(unit.id);
    } finally {
      setVacating(false);
    }
  }

  return (
    <div>
      {picking && <AssignEmployeeModal unit={unit} onClose={() => setPicking(false)} />}
      {confirming && (
        <ConfirmDialog
          title={`Vacate ${unit.label}?`}
          confirmLabel={`Vacate ${unit.label}`}
          disabled={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void vacate();
          }}
        >
          {contactName(state, holderId) ? `${contactName(state, holderId)} comes off ${unit.label}.` : `${unit.label} is left with nobody on it.`}
        </ConfirmDialog>
      )}
      <div className={styles.actionsRow}>
        {assigned && (
          <Button variant="danger" style={{ flex: 1, justifyContent: 'center' }} disabled={busy} onClick={() => setConfirming(true)}>
            {vacating && <ButtonSpinner />}
            Vacate
          </Button>
        )}
        <Button variant="primary" style={{ flex: 1, justifyContent: 'center' }} disabled={busy} onClick={() => setPicking(true)}>
          {assigned ? 'Reassign' : 'Select employee'}
        </Button>
      </div>
      <p className={styles.dragHint} style={{ marginTop: 8 }}>
        Or drag a person from the list below onto this space.
      </p>
    </div>
  );
}
