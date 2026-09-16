import { useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { assignEmployeeToRecord } from '../../lib/facilioApiDataSource';
import { initials } from '../../state/selectors';
import type { Unit } from '../../lib/types';
import { TYPE_META } from '../../lib/types';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
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
 * the whole point of the action.
 */
export function AssignEmployeeModal({ unit, onClose, onAssigned }: { unit: Unit; onClose: () => void; onAssigned?: () => void }) {
  const { state, actions } = useFloorplan();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? state.employees.filter((e) => e.name.toLowerCase().includes(q)) : state.employees;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [state.employees, query]);

  async function pick(employeeId: string, name: string) {
    setBusyId(employeeId);
    actions.setUnitBusy(unit.id);
    try {
      await assignEmployeeToRecord(unit, employeeId);
      // The org has it; mirror it locally so the marker's initials and the sidebar's
      // "Assigned · …" update now rather than on the next floor load.
      actions.markAssigned(unit.id, employeeId);
      actions.showToast(`${unit.label} assigned to ${name}`);
      onAssigned?.();
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
      <div className={styles.body}>
        <input
          className={styles.search}
          value={query}
          autoFocus
          placeholder={`Search ${state.employees.length} people`}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search people"
        />
        <div className={styles.list}>
          {people.map((p) => (
            <button key={p.id} className={styles.row} disabled={busyId !== null} onClick={() => void pick(p.id, p.name)}>
              <span className={styles.avatar}>{initials(p.name)}</span>
              <span className={styles.name}>{p.name}</span>
              {busyId === p.id && <ButtonSpinner />}
            </button>
          ))}
          {people.length === 0 && (
            <div className={styles.empty}>
              {state.employees.length === 0 ? 'No people loaded for this org yet.' : `Nobody matches “${query.trim()}”.`}
            </div>
          )}
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
