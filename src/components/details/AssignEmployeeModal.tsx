import { useMemo, useState } from 'react';
import { useLivePeople } from '../../hooks/useLivePeople';
import { useFloorplanData } from '../../state/FloorplanContext';
import { assignEmployeeToRecord, resolveUnitRecord } from '../../lib/facilioApiDataSource';
import { initials } from '../../state/selectors';
import { byPersonName, personDisplayName } from '../../lib/displayNames';
import type { Unit } from '../../lib/types';
import { TYPE_META } from '../../lib/types';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { SkeletonRows } from '../primitives/Skeleton';
import styles from './AssignEmployeeModal.module.css';

/**
 * Picks the person for an Assign / Allocate transition, and writes them onto the ORG RECORD —
 * `desks.employee`, `lockers.employee`, `parkingstall.employee`.
 *
 * The transition button used to open the details panel, which assigns in this app's own state
 * only; the record itself kept an empty `employee`, so anyone looking at the desk in Facilio saw
 * it as unheld. This writes the field and then lets the record's stateflow advance
 * (`assignEmployeeToRecord`), which is the pair of steps the real client performs.
 *
 * A full-size dialog rather than a dropdown: an org directory is long, and picking a colleague is
 * the whole point of the action. It is the ONE way this app picks a person — the plan's popover
 * and the sidebar both open this, rather than the sidebar keeping a select of its own that wrote
 * somewhere else.
 */
export function AssignEmployeeModal({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const { actions } = useFloorplanData();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function pick(employeeId: string, name: string) {
    setBusyId(employeeId);
    actions.setUnitBusy(unit.id);
    try {
      if (resolveUnitRecord(unit)) {
        await assignEmployeeToRecord(unit, employeeId);
        // The org has it; mirror it locally so the marker's initials and the sidebar's
        // "Assigned · …" update now rather than on the next floor load — then re-read this desk's
        // holder and the person's other desks here, since a desk move can clear the one they held.
        actions.markAssigned(unit.id, employeeId);
        // Then every surface showing a record the move changed re-reads it (its flow, its record
        // card): this desk at once, since the org's write to it went through, and the desks the
        // holders' re-read finds changed (the person's previous desk) once it answers.
        actions.recordChanged([unit.id]);
        void actions.refreshAssignments([unit.id], [employeeId]).then(
          (ids) => {
            const others = (ids ?? []).filter((id) => id !== unit.id);
            if (others.length) actions.recordChanged(others);
          },
          () => undefined,
        );
        actions.showToast(`${unit.label} assigned to ${name}`);
      } else {
        // No org record behind this unit (the local/demo tier): assign it the app's own way, and
        // let it report itself. The dialog is still the right place to choose a person — only
        // where the answer is written differs.
        await actions.assign(employeeId, unit.id);
      }
    } catch (err) {
      // Reported the way every other failure in this app is — a toast — rather than a banner
      // inside a dialog the user then has to dismiss themselves.
      actions.showToast(`Could not assign ${unit.label} — ${(err as Error)?.message ?? 'the org refused it'}`);
    } finally {
      setBusyId(null);
      actions.setUnitBusy(null);
      onClose();
    }
  }

  return (
    <Modal onClose={onClose} width={640}>
      <ModalHeader
        title={`Assign ${TYPE_META[unit.type].name.toLowerCase()}`}
        subtitle={`${unit.label} — pick who it belongs to`}
        onClose={onClose}
      />
      <PeoplePicker query={query} onQuery={setQuery} busyId={busyId} onPick={(id, name) => void pick(id, name)} />
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * The search and the list: the app's roster, searched at the org as you type (useLivePeople).
 * Retry searches again; what was typed lives in the dialog and survives it.
 *
 * Nothing to show is told apart from nothing having arrived: shimmer rows while the org is being
 * asked, "Couldn't load people · Retry" when the read failed and left nothing to show (the hook
 * says so — it used to be guessed from an empty list), and "Nobody matches …" only for a search
 * that was actually typed and answered.
 */
function PeoplePicker({
  query,
  onQuery,
  busyId,
  onPick,
}: {
  query: string;
  onQuery: (q: string) => void;
  busyId: string | null;
  onPick: (employeeId: string, name: string) => void;
}) {
  const { state, actions } = useFloorplanData();
  // The roster the app holds when the dialog opens — nothing is read for it — and the org's own
  // answer while typing: this is the one place a person is chosen, so someone outside the roster
  // must still be findable.
  const { people: live, loading: waiting, loadFailed, retry } = useLivePeople(query, state.employees, { rosterStatus: state.rosterStatus, reloadRoster: actions.reloadRoster });
  const people = useMemo(() => [...live].sort(byPersonName), [live]);

  return (
    <div className={styles.body}>
      <input
        className={styles.search}
        value={query}
        autoFocus
        placeholder={waiting ? 'Loading people…' : `Search ${people.length} people`}
        onChange={(e) => onQuery(e.target.value)}
        aria-label="Search people"
      />
      <div className={styles.list} aria-busy={waiting && people.length === 0}>
        {people.map((p) => (
          <button key={p.id} type="button" className={styles.row} disabled={busyId !== null} onClick={() => onPick(p.id, personDisplayName(p.name))}>
            <span className={styles.avatar}>{initials(p.name)}</span>
            <span className={styles.name}>{personDisplayName(p.name)}</span>
            {busyId === p.id && <ButtonSpinner />}
          </button>
        ))}
        {people.length === 0 &&
          (waiting ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <SkeletonRows rows={6} avatar />
            </div>
          ) : loadFailed ? (
            <div className={styles.empty} role="alert">
              {query.trim() ? 'Couldn’t search people.' : 'Couldn’t load people.'}{' '}
              <button type="button" className={styles.retry} onClick={retry}>
                Retry
              </button>
            </div>
          ) : query.trim() ? (
            <div className={styles.empty}>Nobody matches “{query.trim()}”.</div>
          ) : (
            <div className={styles.empty}>No people in this org yet.</div>
          ))}
      </div>
    </div>
  );
}
