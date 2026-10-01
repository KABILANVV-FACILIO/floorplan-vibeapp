import { useEffect, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { executeStateTransition, fetchAvailableStates, findCancelTransition } from '../../lib/stateflowApi';
import type { FlowState, TransitionOption } from '../../lib/stateflowApi';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import styles from './StateflowActions.module.css';

/**
 * A booking record's stateflow: its current state and every transition the org offers on it
 * (Cancel, Approve, Check in, …), fired directly. The unit-level `StateflowActions` resolves a
 * placed unit's record and special-cases Assign; a booking is a `spacebooking` record named by
 * id, with nothing of that, so it gets its own thin bar.
 *
 * `onChanged` fires after a transition went through — the calendar re-reads its range on it.
 */
export function BookingStateflowActions({ recordId, onChanged }: { recordId: number; onChanged?: () => void }) {
  const { state, actions } = useFloorplanData();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setFlow(null);
    setFailed(false);
    fetchAvailableStates('spacebooking', recordId)
      .then((f) => alive && setFlow(f))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [recordId, state.recordNonce]);

  async function run(t: TransitionOption) {
    let data: Record<string, unknown> | undefined;
    if (t.commentRequired) {
      const body = window.prompt(`Comment for “${t.name}”`);
      if (body == null) return; // cancelled — not a failure
      data = { transitionCommentData: { body, bodyHTML: body } };
    }
    setBusyId(t.id);
    try {
      await executeStateTransition('spacebooking', recordId, t.id, data);
      actions.showToast(`Booking: ${t.name}`);
      // The plan's own day list holds this booking too — re-read it for the selected date.
      void actions.setDate(state.date);
      onChanged?.();
    } catch (err) {
      actions.showToast(`Could not ${t.name} — ${(err as Error)?.message ?? 'the org refused it'}`);
    } finally {
      setBusyId(null);
    }
  }

  if (failed) return null;
  if (!flow) return null;
  const transitions = flow.transitions;
  if (!flow.currentStateName && transitions.length === 0) return null;
  const cancel = findCancelTransition(transitions);

  return (
    <div className={styles.wrap}>
      {flow.currentStateName && (
        <div className={styles.stateRow}>
          <span className={styles.stateLabel}>State</span>
          <span className={styles.stateValue}>{flow.currentStateName}</span>
        </div>
      )}
      {transitions.length > 0 && (
        <div className={styles.actions}>
          {transitions.map((t) => (
            <Button
              key={t.id}
              variant={t === cancel ? 'danger' : 'secondary'}
              style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}
              disabled={busyId !== null}
              onClick={() => void run(t)}
            >
              {busyId === t.id && <ButtonSpinner />}
              {t.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
