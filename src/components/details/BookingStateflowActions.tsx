import { useEffect, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { executeStateTransition, findCancelTransition, readFlow } from '../../lib/stateflowApi';
import type { FlowState, TransitionOption } from '../../lib/stateflowApi';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { PromptDialog } from '../primitives/PromptDialog';
import { transitionCommentData } from './transitionComment';
import styles from './StateflowActions.module.css';

/**
 * A booking record's stateflow: its current state and every transition the org offers on it
 * (Cancel, Approve, Check in, …), fired directly. The unit-level `StateflowActions` resolves a
 * placed unit's record and special-cases Assign; a booking is a `spacebooking` record named by
 * id, with nothing of that, so it gets its own thin bar.
 *
 * The flow is read when the card's actions are OPENED, not when the card appears. "My bookings"
 * lists every booking in the range, and reading each card's flow as the list drew sent one request
 * per card at once, against the same per-minute limit everything else in the app shares. So a card
 * shows an "Actions" button and reads its own flow when that is pressed — one press more than
 * before, and only for the booking the user is actually acting on. `autoLoad` reads straight away,
 * for a surface showing ONE booking (the calendar's single-booking preview), where the user opened
 * that booking precisely to act on it.
 *
 * It re-reads only its OWN record, after its own transition. It used to re-read on every
 * `recordNonce` bump — which every desk assign and vacate on the plan bumps — so each open card
 * asked again whenever anything anywhere changed. Two cards for one booking (or one card mounting
 * twice) share one request through `readFlow`, which also drops what it holds for the booking
 * once a transition runs on it, so a card opened after one reads the booking as it is now.
 *
 * Cancel asks "are you sure?" first, and a step that needs a comment asks for it in the app's own
 * dialog. `onChanged` fires after a transition went through — the calendar re-reads its range on it.
 */
export function BookingStateflowActions({ recordId, onChanged, autoLoad = false }: { recordId: number; onChanged?: () => void; autoLoad?: boolean }) {
  const { state, actions } = useFloorplanData();
  const [opened, setOpened] = useState(autoLoad);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** Bumped after this card's own transition: the one thing that makes it read its record again. */
  const [version, setVersion] = useState(0);
  /** Bumped by Retry after a read that failed. */
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState<TransitionOption | null>(null);
  const [commenting, setCommenting] = useState<TransitionOption | null>(null);

  useEffect(() => {
    if (!opened) return;
    let alive = true;
    // A re-read after a transition keeps the old buttons up until the new ones land — the same
    // booking's, just possibly stale — rather than blanking the card under the user's cursor.
    if (version === 0) setFlow(null);
    setFailed(false);
    readFlow('spacebooking', recordId, version)
      .then((f) => alive && setFlow(f))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [recordId, opened, version, attempt]);

  function onPick(t: TransitionOption, isCancel: boolean) {
    // The comment dialog has its own Cancel, so a Cancel that needs a comment is asked once.
    if (t.commentRequired) setCommenting(t);
    else if (isCancel) setConfirming(t);
    else void run(t);
  }

  async function run(t: TransitionOption, data?: Record<string, unknown>) {
    setBusyId(t.id);
    try {
      await executeStateTransition('spacebooking', recordId, t.id, data);
      actions.showToast(`Booking: ${t.name}`);
      // The plan's day list is re-read only where it can be out of date because of this: while the
      // plan is on screen, or when that list holds this very booking (it would still show it
      // after a cancel when the user went back to the plan). A booking acted on from the calendar
      // on another floor or day changes nothing the plan shows, and the re-read cost requests.
      if (state.activeView === 'map' || state.bookings.some((b) => b.id === String(recordId))) void actions.setDate(state.date);
      setVersion((v) => v + 1);
      onChanged?.();
    } catch (err) {
      actions.showToast(`Could not ${t.name} — ${(err as Error)?.message ?? 'the org refused it'}`);
    } finally {
      setBusyId(null);
    }
  }

  if (!opened) {
    return (
      <div className={styles.wrap}>
        <div className={styles.actions}>
          <Button variant="secondary" style={{ flex: 1, minWidth: 0, justifyContent: 'center' }} aria-expanded={false} onClick={() => setOpened(true)}>
            Actions
          </Button>
        </div>
      </div>
    );
  }
  // Opened, and the org could not be read: said, rather than the Actions button silently vanishing.
  if (failed) {
    return (
      <div className={styles.wrap}>
        <p style={{ margin: 0, font: '400 12px/1.5 var(--font-sans)', color: 'var(--ink-500)' }}>
          Couldn’t read this booking’s actions.{' '}
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            style={{ border: 'none', background: 'none', padding: 0, font: '600 12px/1.5 var(--font-sans)', color: 'var(--blue-600)', textDecoration: 'underline', cursor: 'pointer' }}
          >
            Retry
          </button>
        </p>
      </div>
    );
  }
  if (!flow) {
    return (
      <div className={styles.wrap}>
        <div className={styles.actions}>
          <Button variant="secondary" style={{ flex: 1, minWidth: 0, justifyContent: 'center' }} disabled aria-busy>
            <ButtonSpinner />
            Loading actions…
          </Button>
        </div>
      </div>
    );
  }
  const transitions = flow.transitions;
  if (!flow.currentStateName && transitions.length === 0) return null;
  const cancel = findCancelTransition(transitions);

  return (
    <div className={styles.wrap}>
      {confirming && (
        <ConfirmDialog
          title="Cancel this booking?"
          confirmLabel={/booking/i.test(confirming.name) ? confirming.name : `${confirming.name} booking`}
          cancelLabel="Keep booking"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const t = confirming;
            setConfirming(null);
            void run(t);
          }}
        >
          It is cancelled in Facilio, and the space is free for others to book.
        </ConfirmDialog>
      )}
      {commenting && (
        <PromptDialog
          title={`Booking: ${commenting.name}`}
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
              onClick={() => onPick(t, t === cancel)}
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
