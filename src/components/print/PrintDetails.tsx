import { Fragment, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import type { RegisterKind, RegisterPrint } from '../../lib/types';
import type { AppState } from '../../state/types';
import { columnsNote, REGISTERS, registerColumns, registerKindsFor } from '../../lib/register';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { Select } from '../primitives/Select';
import styles from './PrintDetails.module.css';

type LabelField = { name: string; label: string } | null;

/** What the plan's page shows. Floor + details: the whole floor, then a zoomed page for every area of desks (or stalls, or lockers), each labelled in full. */
const SCOPES: { value: AppState['printScope']; label: string }[] = [
  { value: 'detail', label: 'Floor + details' },
  { value: 'view', label: 'Current view' },
  { value: 'floor', label: 'Whole floor' },
];

/**
 * The print window's settings: what the plan's page shows (Plan), and what the registers after it
 * list — desks and rooms after a desk plan, stalls after a parking plan, lockers after a locker plan
 * — a tab each, every kind with its own choices. Staged like the Settings modals — nothing reaches
 * the pages until Apply, which applies the plan and every tab — and kept for everyone (the settings
 * blob), so every printout reads the same.
 */
export function PrintDetails({ labelFields, onClose }: { labelFields: Partial<Record<RegisterKind, LabelField>>; onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const kinds = registerKindsFor(state.planId);
  const [scope, setScope] = useState(state.printScope);
  const [tab, setTab] = useState<RegisterKind>(kinds[0]);
  const [drafts, setDrafts] = useState<Record<RegisterKind, RegisterPrint>>(() => {
    const out = {} as Record<RegisterKind, RegisterPrint>;
    for (const k of Object.keys(state.printRegisters) as RegisterKind[]) out[k] = { ...state.printRegisters[k], cols: [...state.printRegisters[k].cols] };
    return out;
  });

  const changedIn = (kind: RegisterKind) => {
    const draft = drafts[kind];
    const applied = state.printRegisters[kind];
    return (
      (draft.register !== applied.register ? 1 : 0) +
      (draft.rows !== applied.rows ? 1 : 0) +
      (draft.sort !== applied.sort ? 1 : 0) +
      REGISTERS[kind].columns.filter((c) => !c.locked && draft.cols.includes(c.key) !== applied.cols.includes(c.key)).length
    );
  };
  const changed = (scope !== state.printScope ? 1 : 0) + kinds.reduce((n, k) => n + changedIn(k), 0);
  const plural = kinds.length > 1;

  return (
    <Modal onClose={onClose} width={560}>
      <ModalHeader title="Print settings" subtitle="What the printed pages show, for everyone who prints them." onClose={onClose} />
      <div className={styles.planRow}>
        <span className={styles.planLabel}>Plan</span>
        <div className={styles.planSeg} role="radiogroup" aria-label="Plan">
          {SCOPES.map((s) => (
            <button key={s.value} type="button" role="radio" aria-checked={scope === s.value} className={[styles.tab, scope === s.value ? styles.tabOn : ''].join(' ')} onClick={() => setScope(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {plural && (
        <div className={styles.planRow}>
          <span className={styles.planLabel}>Details</span>
          <div className={styles.tabs} role="tablist" aria-label="Details">
            {kinds.map((k) => {
              const n = changedIn(k);
              return (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={[styles.tab, tab === k ? styles.tabOn : ''].join(' ')} onClick={() => setTab(k)}>
                  {REGISTERS[k].many[0].toUpperCase() + REGISTERS[k].many.slice(1)}
                  {n > 0 && <span className={styles.tabDot} aria-label={`${n} unsaved`} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <RegisterChoices key={tab} kind={tab} draft={drafts[tab]} labelField={labelFields[tab] ?? null} onChange={(d) => setDrafts((all) => ({ ...all, [tab]: d }))} />
      <ModalFooter>
        <span className={styles.count}>{changed ? `${changed} ${changed === 1 ? 'change' : 'changes'}` : 'No changes'}</span>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!changed}
          onClick={() => {
            if (scope !== state.printScope) actions.setPrintScope(scope);
            for (const k of kinds) {
              if (!changedIn(k)) continue;
              // Kept in register order, whatever order they were ticked in.
              const cols = REGISTERS[k].columns.map((c) => c.key).filter((key) => drafts[k].cols.includes(key));
              actions.setPrintRegister(k, { ...drafts[k], cols });
            }
            onClose();
          }}
        >
          Apply
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** One register's choices: printed or not, its columns by where they come from, which rows and their order. */
function RegisterChoices({ kind, draft, labelField, onChange }: { kind: RegisterKind; draft: RegisterPrint; labelField: LabelField; onChange: (d: RegisterPrint) => void }) {
  const catalog = REGISTERS[kind];
  const note = columnsNote(registerColumns(draft, labelField, kind).length);
  const toggle = (key: string) => onChange({ ...draft, cols: draft.cols.includes(key) ? draft.cols.filter((k) => k !== key) : [...draft.cols, key] });
  const toggleGroup = (keys: string[], allOn: boolean) =>
    onChange({ ...draft, cols: allOn ? draft.cols.filter((k) => !keys.includes(k)) : [...draft.cols, ...keys.filter((k) => !draft.cols.includes(k))] });

  return (
    <div className={styles.body}>
      <section className={styles.section}>
        <div className={styles.switchRow}>
          <button
            type="button"
            className={[styles.switch, draft.register ? styles.switchOn : ''].join(' ')}
            role="switch"
            aria-checked={draft.register}
            aria-label={catalog.title}
            onClick={() => onChange({ ...draft, register: !draft.register })}
          >
            <span className={styles.knob} />
          </button>
          <h4 className={styles.heading}>{catalog.title}</h4>
        </div>

        {draft.register && (
          <>
            <div className={styles.colsHead}>
              <span className={styles.hint}>Columns</span>
              <span className={[styles.colsNote, note.warn ? styles.warn : ''].join(' ')}>{note.text}</span>
            </div>
            {catalog.groups.map((g) => {
              const cols = catalog.columns.filter((c) => c.group === g.key);
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
                        <Option id={`print-col-${kind}-${c.key}`} label={c.label} checked={!!c.locked || draft.cols.includes(c.key)} locked={c.locked} onToggle={() => toggle(c.key)} />
                        {/* The plan's label prints next to the name, so it is listed there. */}
                        {c.key === 'name' && labelField && <Option id={`print-col-${kind}-label`} label={labelField.label} checked locked onToggle={() => {}} />}
                      </Fragment>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className={styles.selRow}>
              <span className={styles.selLabel}>{catalog.many[0].toUpperCase() + catalog.many.slice(1)}</span>
              <Select
                value={draft.rows}
                options={(Object.keys(catalog.rowChoices) as RegisterPrint['rows'][]).map((v) => ({ value: v, label: catalog.rowChoices[v] }))}
                onChange={(v) => onChange({ ...draft, rows: v })}
                size="sm"
                aria-label={`Which ${catalog.many}`}
              />
              <span className={styles.selLabel}>Sort by</span>
              <Select
                value={catalog.sorts.some((s) => s.value === draft.sort) ? draft.sort : catalog.sorts[0].value}
                options={catalog.sorts.map((s) => ({ value: s.value, label: s.label }))}
                onChange={(v) => onChange({ ...draft, sort: v })}
                size="sm"
                aria-label="Sort by"
              />
            </div>
          </>
        )}
      </section>
    </div>
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
