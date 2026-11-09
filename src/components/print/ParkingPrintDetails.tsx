import { Fragment, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import type { ParkingPrint } from '../../lib/types';
import { columnsNote, REGISTER_COLUMNS, REGISTER_GROUPS, registerColumns } from '../../lib/parkingRegister';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { Select } from '../primitives/Select';
import styles from './ParkingPrintDetails.module.css';

const ROWS: { value: ParkingPrint['rows']; label: string }[] = [
  { value: 'all', label: 'All stalls' },
  { value: 'assigned', label: 'Assigned only' },
  { value: 'vacant', label: 'Vacant only' },
];
const SORTS: { value: ParkingPrint['sort']; label: string }[] = [
  { value: 'name', label: 'Stall' },
  { value: 'status', label: 'Status' },
  { value: 'dept', label: 'Department' },
  { value: 'emp', label: 'Assigned person' },
];

/**
 * The print window's Details, for a parking plan: what the parking register after the plan lists.
 * Staged like the Settings modals — nothing reaches the pages until Apply — and kept for everyone
 * who prints parking (the settings blob), so every printout of the car park reads the same.
 */
export function ParkingPrintDetails({ labelField, onClose }: { labelField: { name: string; label: string } | null; onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const [draft, setDraft] = useState<ParkingPrint>(() => ({ ...state.parkingPrint, cols: [...state.parkingPrint.cols] }));

  const applied = state.parkingPrint;
  const changed =
    (draft.register !== applied.register ? 1 : 0) +
    (draft.rows !== applied.rows ? 1 : 0) +
    (draft.sort !== applied.sort ? 1 : 0) +
    REGISTER_COLUMNS.filter((c) => !c.locked && draft.cols.includes(c.key) !== applied.cols.includes(c.key)).length;
  const note = columnsNote(registerColumns(draft, labelField).length);

  const toggle = (key: string) => setDraft((d) => ({ ...d, cols: d.cols.includes(key) ? d.cols.filter((k) => k !== key) : [...d.cols, key] }));
  const toggleGroup = (keys: string[], allOn: boolean) =>
    setDraft((d) => ({ ...d, cols: allOn ? d.cols.filter((k) => !keys.includes(k)) : [...d.cols, ...keys.filter((k) => !d.cols.includes(k))] }));

  return (
    <Modal onClose={onClose} width={560}>
      <ModalHeader title="Print details" subtitle="What the printed parking pages show, for everyone who prints them." onClose={onClose} />
      <div className={styles.body}>
        <section className={styles.section}>
          <h4 className={styles.heading}>On the plan</h4>
          <p className={styles.note}>
            Each stall reads its <b>{labelField?.label ?? 'name'}</b>
            {state.parkingLabel.showHolder ? ', with the assigned person under it' : ', without the assigned person'}. Change this in Settings › Parking › Label on the plan.
          </p>
        </section>

        <section className={styles.section}>
          <div className={styles.switchRow}>
            <button
              type="button"
              className={[styles.switch, draft.register ? styles.switchOn : ''].join(' ')}
              role="switch"
              aria-checked={draft.register}
              aria-label="Parking register"
              onClick={() => setDraft((d) => ({ ...d, register: !d.register }))}
            >
              <span className={styles.knob} />
            </button>
            <div>
              <h4 className={styles.heading}>Parking register</h4>
              <p className={styles.hint}>Pages after the plan, one row per stall, a column per detail</p>
            </div>
          </div>

          {draft.register && (
            <>
              <div className={styles.colsHead}>
                <span className={styles.hint}>Columns</span>
                <span className={[styles.colsNote, note.warn ? styles.warn : ''].join(' ')}>{note.text}</span>
              </div>
              {REGISTER_GROUPS.map((g) => {
                const cols = REGISTER_COLUMNS.filter((c) => c.group === g.key);
                const free = cols.filter((c) => !c.locked).map((c) => c.key);
                const allOn = free.every((k) => draft.cols.includes(k));
                return (
                  <div key={g.key} className={styles.group}>
                    <div className={styles.groupHead}>
                      <b>{g.label}</b>
                      <button type="button" className={styles.link} onClick={() => toggleGroup(free, allOn)}>
                        {allOn ? 'Clear' : 'Select all'}
                      </button>
                    </div>
                    <div className={styles.list}>
                      {cols.map((c) => (
                        <Fragment key={c.key}>
                          <Option id={`print-col-${c.key}`} label={c.label} checked={!!c.locked || draft.cols.includes(c.key)} locked={c.locked} onToggle={() => toggle(c.key)} />
                          {/* The plan's label prints next to the name, so it is listed there. */}
                          {c.key === 'name' && labelField && <Option id="print-col-label" label={labelField.label} checked locked onToggle={() => {}} />}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className={styles.selRow}>
                <span className={styles.selLabel}>Stalls</span>
                <Select value={draft.rows} options={ROWS} onChange={(v) => setDraft((d) => ({ ...d, rows: v }))} size="sm" aria-label="Which stalls" />
                <span className={styles.selLabel}>Sort by</span>
                <Select value={draft.sort} options={SORTS} onChange={(v) => setDraft((d) => ({ ...d, sort: v }))} size="sm" aria-label="Sort by" />
              </div>
            </>
          )}
        </section>
      </div>
      <ModalFooter>
        <span className={styles.count}>{changed ? `${changed} ${changed === 1 ? 'change' : 'changes'}` : 'No changes'}</span>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!changed}
          onClick={() => {
            // Kept in register order, whatever order they were ticked in.
            const cols = REGISTER_COLUMNS.map((c) => c.key).filter((k) => draft.cols.includes(k));
            actions.setParkingPrint({ ...draft, cols });
            onClose();
          }}
        >
          Apply
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function Option({ id, label, checked, locked, onToggle }: { id: string; label: string; checked: boolean; locked?: boolean; onToggle: () => void }) {
  return (
    <label className={styles.opt} htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={locked} onChange={onToggle} />
      <span className={styles.optName}>{label}</span>
    </label>
  );
}
