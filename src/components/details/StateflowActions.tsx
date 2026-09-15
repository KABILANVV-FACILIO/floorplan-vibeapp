import { useCallback, useEffect, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { invalidateUnitRecordInfo, resolveUnitRecord } from '../../lib/facilioApiDataSource';
import { executeStateTransition, fetchAvailableStates, isAssignTransition } from '../../lib/stateflowApi';
import type { FlowState, TransitionOption } from '../../lib/stateflowApi';
import type { Unit } from '../../lib/types';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { AssignEmployeeModal } from './AssignEmployeeModal';
import styles from './StateflowActions.module.css';

/**
 * The record's stateflow: where it is now, and the transitions the org's own flow offers from
 * there. Every module in this app is stateflow-enabled in the orgs that use it (desks, lockers,
 * parkingstall and space all carry `STATE_FLOW_ENABLED`), and until now the app could neither show
 * the state nor move it.
 *
 * Deliberately thin, and NOT a port of the upstream component — that one is wired into a state
 * layer this app doesn't have (a global pending flag, a unit nonce, a people picker). Here the
 * pending state is local, and a completed transition invalidates the cached record so whatever is
 * showing the record's details re-reads them.
 *
 * EVERY transition the API offers is rendered, and nothing that it doesn't — the Assign, Re-assign
 * and Vacate buttons used to be hardcoded off the app's own view of occupancy, so they appeared
 * whether or not the org's flow actually allowed the move, and the user's real options never
 * showed at all.
 *
 * Assign and Re-assign are the one exception to FIRING: they are record writes with their own
 * picker in this app, so those buttons open it instead of running the transition (the state then
 * follows the write — see `runAssignTransition`). Vacate and everything else go straight to the
 * transition API.
 */
export function StateflowActions({ unit, showState = true, onChanged }: { unit: Unit; showState?: boolean; onChanged?: () => void }) {
  const { actions } = useFloorplan();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);

  const ref = resolveUnitRecord(unit);
  const moduleName = ref?.moduleName;
  const recordId = ref?.recordId;

  const load = useCallback(async () => {
    if (!moduleName || !recordId) return;
    try {
      setFlow(await fetchAvailableStates(moduleName, recordId));
      setFailed(false);
    } catch {
      // No stateflow on this module, or the endpoint isn't reachable — render nothing rather than
      // an error the user can do nothing about.
      setFlow(null);
      setFailed(true);
    }
  }, [moduleName, recordId]);

  useEffect(() => {
    setFlow(null);
    setFailed(false);
    void load();
  }, [load]);

  /**
   * Assign / Re-assign / Allocate open the people picker rather than firing: choosing the person
   * IS the action, and the transition follows the write (see `assignEmployeeToRecord`). Everything
   * else — Vacate, Block, whatever the org defines — executes directly.
   */
  function onPick(t: TransitionOption) {
    if (isAssignTransition(t)) {
      setPicking(true);
      return;
    }
    void run(t);
  }

  async function run(t: TransitionOption) {
    if (!moduleName || !recordId) return;
    let data: Record<string, unknown> | undefined;
    if (t.commentRequired) {
      const body = window.prompt(`Comment for “${t.name}”`);
      if (body == null) return; // cancelled — not a failure
      data = { transitionCommentData: { body, bodyHTML: body } };
    }
    setBusyId(t.id);
    try {
      await executeStateTransition(moduleName, recordId, t.id, data);
      invalidateUnitRecordInfo(unit);
      await load();
      onChanged?.();
      actions.showToast(`${unit.label}: ${t.name}`);
    } catch (err) {
      actions.showToast(`Could not ${t.name} — ${(err as Error)?.message ?? 'the org refused it'}`);
    } finally {
      setBusyId(null);
    }
  }

  if (!ref || failed) return null;
  const transitions = flow?.transitions ?? [];
  if (!flow || (!flow.currentStateName && transitions.length === 0)) return null;
  // The popover already reports the state in its pill; repeating it here is the duplication that
  // made a vacant desk say the same thing three times.
  const withState = showState && !!flow.currentStateName;
  if (!withState && transitions.length === 0) return null;

  return (
    <div className={styles.wrap}>
      {picking && (
        <AssignEmployeeModal
          unit={unit}
          onClose={() => setPicking(false)}
          onAssigned={() => {
            void load();
            onChanged?.();
          }}
        />
      )}
      {withState && (
        <div className={styles.stateRow}>
          <span className={styles.stateLabel}>State</span>
          <span className={styles.stateValue}>{flow.currentStateName}</span>
        </div>
      )}
      {transitions.length > 0 && (
        <div className={styles.actions}>
          {transitions.map((t, i) => (
            <Button
              key={t.id}
              variant={i === 0 ? 'primary' : 'secondary'}
              style={{ flex: 1, justifyContent: 'center' }}
              disabled={busyId !== null}
              onClick={() => onPick(t)}
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
