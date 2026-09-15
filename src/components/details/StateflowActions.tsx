import { useCallback, useEffect, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { invalidateUnitRecordInfo, resolveUnitRecord } from '../../lib/facilioApiDataSource';
import { executeStateTransition, fetchAvailableStates } from '../../lib/stateflowApi';
import type { FlowState, TransitionOption } from '../../lib/stateflowApi';
import type { Unit } from '../../lib/types';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
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
 * Assign-ish transitions are hidden: assignment in this app is a record write with its own UI
 * (the Assign panel), and offering a second, divergent path to it from here would be two ways to
 * do one thing. Vacate-ish ones are NOT hidden — those genuinely are the flow's job.
 */
export function StateflowActions({ unit, showState = true, onChanged }: { unit: Unit; showState?: boolean; onChanged?: () => void }) {
  const { actions } = useFloorplan();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

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
  // Assignment has its own UI; see the note above.
  const transitions = (flow?.transitions ?? []).filter((t) => !/^\s*(re-?)?assign\b/i.test(t.name));
  if (!flow || (!flow.currentStateName && transitions.length === 0)) return null;
  // The popover already reports the state in its pill; repeating it here is the duplication that
  // made a vacant desk say the same thing three times.
  const withState = showState && !!flow.currentStateName;
  if (!withState && transitions.length === 0) return null;

  return (
    <div className={styles.wrap}>
      {withState && (
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
              variant="secondary"
              style={{ flex: 1, justifyContent: 'center' }}
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
