import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { invalidateUnitRecordInfo, resolveUnitRecord } from '../../lib/facilioApiDataSource';
import { executeStateTransition, fetchAvailableStates, isAssignTransition } from '../../lib/stateflowApi';
import type { FlowState, TransitionOption } from '../../lib/stateflowApi';
import type { Unit } from '../../lib/types';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { AssignEmployeeModal } from './AssignEmployeeModal';
import styles from './StateflowActions.module.css';

/** How many transitions get a button of their own before the rest move under the overflow. */
const INLINE_ACTIONS = 2;

/**
 * The record's stateflow: where it is now, and the transitions the org's own flow offers from
 * there. Every module in this app is stateflow-enabled in the orgs that use it (desks, lockers,
 * parkingstall and space all carry `STATE_FLOW_ENABLED`), and until now the app could neither show
 * the state nor move it.
 *
 * Deliberately thin, and NOT a port of the upstream component — that one is wired into a state
 * layer this app doesn't have (a global pending flag, a unit nonce, a people picker). Here only
 * WHICH button was pressed is local: the record being written to is app state (`busyUnitId`), and
 * so is the fact that it changed (`recordNonce`), because both are true of the record rather than
 * of the surface you happened to press.
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
export function StateflowActions({
  unit,
  showState = true,
  fallback,
}: {
  unit: Unit;
  showState?: boolean;
  /**
   * What to show when this record has no flow to offer — no org record behind it at all (the
   * local/demo tier), or a module the org hasn't put a stateflow on. Without it a surface whose
   * only actions come from the flow would offer nothing at all on those records.
   */
  fallback?: ReactNode;
}) {
  const { state, actions } = useFloorplan();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showMore, setShowMore] = useState(false);

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

  // Drop the previous record's flow the moment the panel points at a different record — its
  // buttons would otherwise sit there, live, over a record they were never read for.
  useEffect(() => {
    setFlow(null);
    setFailed(false);
    setShowMore(false);
  }, [moduleName, recordId]);

  // `recordNonce` is in the deps because a write anywhere — this panel, the plan's popover, the
  // people picker — changes which transitions this record offers next. A re-read leaves the
  // current buttons up until the new ones arrive: they are the same record's, just possibly stale.
  useEffect(() => {
    void load();
  }, [load, state.recordNonce]);

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
    // The record itself is busy, not just this button — the marker on the plan spins too, because
    // the transition is happening to the thing you are looking at, not to the control you pressed.
    actions.setUnitBusy(unit.id);
    try {
      await executeStateTransition(moduleName, recordId, t.id, data);
      invalidateUnitRecordInfo(unit);
      // Re-read the record: a transition is exactly what changes its state and its holder, and
      // Vacate clears `employee`, which drives the marker's initials and the sidebar's pill.
      // `recordChanged` re-reads it on every surface showing it, not just this one.
      await actions.refreshAssignments();
      actions.recordChanged();
      actions.showToast(`${unit.label}: ${t.name}`);
    } catch (err) {
      actions.showToast(`Could not ${t.name} — ${(err as Error)?.message ?? 'the org refused it'}`);
    } finally {
      setBusyId(null);
      setShowMore(false);
      actions.setUnitBusy(null);
    }
  }

  // No record behind this unit, or no flow on its module: the org has no opinion about what you
  // may do to it, so the caller's own controls stand in.
  if (!ref || failed) return <>{fallback}</>;
  const transitions = flow?.transitions ?? [];
  // Still reading the flow — show nothing rather than flashing the fallback's buttons and
  // replacing them a moment later with the org's.
  if (!flow) return null;
  if (!flow.currentStateName && transitions.length === 0) return <>{fallback}</>;
  // The popover already reports the state in its pill; repeating it here is the duplication that
  // made a vacant desk say the same thing three times.
  const withState = showState && !!flow.currentStateName;
  if (!withState && transitions.length === 0) return <>{fallback}</>;
  // A write to this record is in flight — possibly started on another surface showing the same
  // record, which must not leave a live second button here pointed at a record mid-transition.
  const recordBusy = state.busyUnitId === unit.id;
  // The flow lists its transitions in its own order, and the first two are the ones a user reaches
  // for; the rest stay one press away rather than wrapping into a wall of buttons in a 300px panel.
  const inline = transitions.slice(0, INLINE_ACTIONS);
  const overflow = transitions.slice(INLINE_ACTIONS);
  // A transition fired from the overflow must still show ITS spinner, so the menu stays open while
  // that one is running.
  const runningInOverflow = overflow.some((t) => t.id === busyId);

  return (
    <div className={styles.wrap}>
      {picking && (
        <AssignEmployeeModal
          unit={unit}
          // The picker bumps `recordNonce` itself, which reloads the flow through the effect
          // above — here and on every other surface showing the record, so it needs no callback.
          onClose={() => setPicking(false)}
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
          {inline.map((t, i) => (
            <Button
              key={t.id}
              variant={i === 0 ? 'primary' : 'secondary'}
              // `minWidth: 0` so these yield rather than pushing the overflow control onto a line
              // of its own in the 304px popover.
              style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}
              disabled={busyId !== null || recordBusy}
              onClick={() => onPick(t)}
            >
              {busyId === t.id && <ButtonSpinner />}
              {t.name}
            </Button>
          ))}
          {overflow.length > 0 && (
            <Button
              variant="secondary"
              className={styles.more}
              aria-label={`${overflow.length} more action${overflow.length === 1 ? '' : 's'}`}
              aria-expanded={showMore || runningInOverflow}
              disabled={busyId !== null || recordBusy}
              onClick={() => setShowMore((v) => !v)}
            >
              ···
            </Button>
          )}
        </div>
      )}
      {overflow.length > 0 && (showMore || runningInOverflow) && (
        <div className={styles.overflow}>
          {overflow.map((t) => (
            <Button
              key={t.id}
              variant="secondary"
              fullWidth
              style={{ justifyContent: 'center' }}
              disabled={busyId !== null || recordBusy}
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
