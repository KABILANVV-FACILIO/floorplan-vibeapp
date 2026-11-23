import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName } from '../../state/selectors';
import { invalidateUnitRecordInfo, resolveUnitRecord, vacateUnitReal, waitForDeskVacated } from '../../lib/facilioApiDataSource';
import { executeStateTransition, isAssignTransition, isVacateTransition, readFlow } from '../../lib/stateflowApi';
import type { FlowState, TransitionOption } from '../../lib/stateflowApi';
import type { Unit } from '../../lib/types';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { PromptDialog } from '../primitives/PromptDialog';
import { AssignEmployeeModal } from './AssignEmployeeModal';
import { transitionCommentData } from './transitionComment';
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
 * so is the fact that it changed (`recordVersions`), because both are true of the record rather
 * than of the surface you happened to press.
 *
 * EVERY transition the API offers is rendered, and nothing that it doesn't — the Assign, Re-assign
 * and Vacate buttons used to be hardcoded off the app's own view of occupancy, so they appeared
 * whether or not the org's flow actually allowed the move, and the user's real options never
 * showed at all.
 *
 * Assign and Re-assign are the one exception to FIRING: they are record writes with their own
 * picker in this app, so those buttons open it instead of running the transition (the state then
 * follows the write — see `runAssignTransition`). Everything else goes to the transition API —
 * Vacate after an "are you sure?", since a mis-click takes someone off their desk in Facilio, and a
 * step that requires a comment after the app's own comment dialog (which is its own way back out).
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
  /** The Vacate waiting on "are you sure?", and the step waiting on its required comment. */
  const [confirming, setConfirming] = useState<TransitionOption | null>(null);
  const [commenting, setCommenting] = useState<TransitionOption | null>(null);
  // The wait for the org to let go of a vacated desk, while one is running (see run()).
  const vacateWait = useRef<AbortController | null>(null);

  const ref = resolveUnitRecord(unit);
  const moduleName = ref?.moduleName;
  const recordId = ref?.recordId;
  // Which version of this record the flow is read at: its own version (bumped by a write to it,
  // on any surface) and the plan-wide one (bumped by a change whose records are not known). The
  // two surfaces showing one desk — the plan's card and the side panel — arrive at the same value,
  // which is what lets them share one read (readFlow).
  const flowVersion = `${state.recordVersions[unit.id] ?? 0}.${state.recordNonce}`;

  // Drop the previous record's flow the moment the panel points at a different record — its
  // buttons would otherwise sit there, live, over a record they were never read for. A question
  // still open about the old record goes with them.
  useEffect(() => {
    setFlow(null);
    setFailed(false);
    setShowMore(false);
    setConfirming(null);
    setCommenting(null);
  }, [moduleName, recordId]);

  // Off this record — the card closed, or it now shows another — the wait for the org to let go
  // of a vacated desk stops: no one is looking at that desk here any more. The action itself is
  // done, and the plan still re-reads its holders once, as it does when the org is slow.
  useEffect(() => () => vacateWait.current?.abort(), [moduleName, recordId]);

  // Re-read when THIS record changes — a write from this panel, the plan's popover or the people
  // picker bumps its version — and on a plan-wide change whose records are not known. It used to
  // re-read on every write anywhere on the plan, so each open card asked again whenever any desk
  // was assigned or vacated. A re-read leaves the current buttons up until the new ones arrive:
  // they are the same record's, just possibly stale.
  //
  // Only the LATEST read may land. Clicking quickly from desk A to desk B left A's slower answer
  // free to arrive after B's and put A's transition ids on B's buttons — where pressing one ran
  // A's step against B's record. Each read is dropped the moment a newer one starts (or the card
  // closes), whatever order the answers come back in. (readFlow shares the REQUEST with the other
  // surface showing this record; which answer this surface shows is still decided here.)
  useEffect(() => {
    if (!moduleName || !recordId) return;
    let alive = true;
    readFlow(moduleName, recordId, flowVersion).then(
      (f) => {
        if (!alive) return;
        setFlow(f);
        setFailed(false);
      },
      () => {
        if (!alive) return;
        // No stateflow on this module, or the endpoint isn't reachable — render nothing rather
        // than an error the user can do nothing about.
        setFlow(null);
        setFailed(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [moduleName, recordId, flowVersion]);

  /**
   * Assign / Re-assign / Allocate open the people picker rather than firing: choosing the person
   * IS the action, and the transition follows the write (see `assignEmployeeToRecord`). A step
   * that requires a comment asks for it first; Vacate asks "are you sure?" first. Everything else —
   * Block, whatever the org defines — executes directly.
   */
  function onPick(t: TransitionOption) {
    if (isAssignTransition(t)) {
      setPicking(true);
      return;
    }
    // The comment dialog has its own Cancel, so a Vacate that needs a comment is asked once, not twice.
    if (t.commentRequired) {
      setCommenting(t);
      return;
    }
    if (isVacateTransition(t)) {
      setConfirming(t);
      return;
    }
    void run(t);
  }

  async function run(t: TransitionOption, data?: Record<string, unknown>) {
    if (!moduleName || !recordId) return;
    setBusyId(t.id);
    const waiting = new AbortController();
    vacateWait.current = waiting;
    // The record itself is busy, not just this button — the marker on the plan spins too, because
    // the transition is happening to the thing you are looking at, not to the control you pressed.
    actions.setUnitBusy(unit.id);
    try {
      // Vacating a DESK is a move record first (the org clears the desk and writes its activity),
      // the state transition second — the other way round, the transition would empty the desk
      // and the move would have no one to take off it.
      const holder = state.assignments?.[unit.id];
      const vacatingDesk = unit.type === 'workstation' && isVacateTransition(t) && !!holder;
      if (vacatingDesk) {
        const out = await vacateUnitReal(unit, holder);
        if (!out.ok) throw new Error(out.reason);
      }
      await executeStateTransition(moduleName, recordId, t.id, data);
      // The move is recorded, but the org clears the desk's `employee` while PROCESSING it, after
      // the request returns. Re-reading now would still name the old holder beside the new
      // "Temporarily Vacant" state. So the desk stays busy until the org has actually let go of
      // them, and only then is anything re-read.
      const settled = vacatingDesk ? await waitForDeskVacated(unit, holder, { signal: waiting.signal }) : { cleared: true };
      invalidateUnitRecordInfo(unit);
      // Re-read the record: a transition is exactly what changes its state and its holder, and
      // Vacate clears `employee`, which drives the marker's initials and the sidebar's pill. Only
      // this record's holder is re-read (and any desk the same move touched), not the floor's.
      const reread = await actions.refreshAssignments([unit.id]);
      // After the list read, not before: a list answered from an older copy would otherwise put
      // the holder straight back. The org has confirmed it, so the plan says so.
      if (vacatingDesk && settled.cleared) actions.clearHolder(unit.id);
      // Every surface showing a record the move changed re-reads it — this one, the other surface
      // showing this desk — and nothing else on the plan does. This record by every id it is
      // known by, whatever the re-read named.
      actions.recordChanged([...new Set([...(reread ?? []), unit.id, String(recordId)])]);
      actions.showToast(
        settled.cleared
          ? `${unit.label}: ${t.name}`
          : `${unit.label}: ${t.name} — Facilio is still updating the desk; it will show as free on the next refresh`,
        settled.cleared ? undefined : 6000
      );
    } catch (err) {
      actions.showToast(`Could not ${t.name} — ${(err as Error)?.message ?? 'the org refused it'}`);
    } finally {
      if (vacateWait.current === waiting) vacateWait.current = null;
      setBusyId(null);
      setShowMore(false);
      actions.setUnitBusy(null);
    }
  }

  // The caller's own controls (the app's "Select employee") stand in for exactly two cases, both
  // ones where the org has no opinion: no org record behind this unit (the demo tier), and a module
  // with no stateflow. Anywhere else the actions ARE the org's transitions, and the app's own
  // buttons would write somewhere the flow never sees.
  if (!ref) return <>{fallback}</>;
  // The flow could not be READ — no Facilio host to ask, or the request failed. That is not the org
  // saying "no flow", and it must not be treated as one: with no host, the app's own Assign writes to
  // this browser alone and then reports it done. So nothing is offered.
  if (failed) return null;
  const transitions = flow?.transitions ?? [];
  // Still reading the flow — show nothing rather than flashing the fallback's buttons and
  // replacing them a moment later with the org's.
  if (!flow) return null;
  if (!flow.currentStateName && transitions.length === 0) return <>{fallback}</>;
  // The popover already reports the state in its pill; repeating it here is the duplication that
  // made a vacant desk say the same thing three times.
  const withState = showState && !!flow.currentStateName;
  // A flow, at a state that offers no transition: the org's answer is "nothing to do here", and
  // the app's own Assign must not override it.
  if (!withState && transitions.length === 0) return null;
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

  const holderName = contactName(state, state.assignments?.[unit.id]);

  return (
    <div className={styles.wrap}>
      {picking && (
        <AssignEmployeeModal
          unit={unit}
          // The picker announces the write against this record's id once the org has it, which
          // reloads the flow through the effect above — here and on every other surface showing
          // the record — so it needs no callback.
          onClose={() => setPicking(false)}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={`${confirming.name} ${unit.label}?`}
          confirmLabel={`${confirming.name} ${unit.label}`}
          // Busy on another surface since the question was asked: nothing to confirm into.
          disabled={recordBusy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const t = confirming;
            setConfirming(null);
            void run(t);
          }}
        >
          {holderName ? `${holderName} comes off ${unit.label} in Facilio.` : `This changes ${unit.label} in Facilio straight away.`}
        </ConfirmDialog>
      )}
      {commenting && (
        <PromptDialog
          title={`${commenting.name} ${unit.label}`}
          label={`Comment for “${commenting.name}”`}
          confirmLabel={commenting.name}
          onCancel={() => setCommenting(null)}
          onSubmit={(body) => {
            const t = commenting;
            setCommenting(null);
            void run(t, transitionCommentData(body));
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
