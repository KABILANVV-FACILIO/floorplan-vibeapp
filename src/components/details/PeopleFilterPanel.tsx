import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchLookupOptions } from '../../lib/facilioApiDataSource';
import { completeFilters } from '../../lib/employeeFilters';
import type { AppliedFilter, FilterFieldDef } from '../../lib/employeeFilters';
import { Button } from '../primitives/Button';
import styles from './PeopleFilterPanel.module.css';

export interface LookupChoice {
  value: string;
  label: string;
  /** Department choices carry their plan colour, so "Finance" here is the purple on the floor. */
  color?: string;
}

/** A long choice list gets its own search box above it. */
const SEARCH_CHOICES_OVER = 8;

/**
 * The People sidebar's filter panel — Facilio's list-page Advanced Search, fitted to a 360px
 * sidebar: "Search fields", then the org's filterable employee fields to tick; ticking one opens
 * its operator and value in place; Clear all / Cancel / Apply at the foot.
 *
 * It covers the People LIST, never the plan, so the floor stays in view while filtering.
 *
 * Edits a DRAFT: nothing reaches the list until Apply, and Cancel (or Esc) throws the draft away —
 * the same contract as the list page, and the reason a half-typed value never fires a request.
 */
export function PeopleFilterPanel({
  fields,
  applied,
  departmentChoices,
  onApply,
  onClose,
}: {
  fields: FilterFieldDef[];
  applied: AppliedFilter[];
  departmentChoices: LookupChoice[];
  onApply: (next: AppliedFilter[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, AppliedFilter>>(() => Object.fromEntries(applied.map((f) => [f.field, { ...f, values: [...f.values] }])));
  const [fieldQuery, setFieldQuery] = useState('');
  const [lookups, setLookups] = useState<Record<string, LookupChoice[] | 'loading' | 'failed'>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);

  const shown = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    return q ? fields.filter((f) => f.label.toLowerCase().includes(q)) : fields;
  }, [fields, fieldQuery]);

  const draftList = Object.values(draft);
  const hasAnything = completeFilters(draftList, fields).length > 0 || applied.length > 0;

  function choicesFor(f: FilterFieldDef): LookupChoice[] | 'loading' | 'failed' {
    if (f.kind === 'options') return f.options ?? [];
    if (f.lookupModule === 'department' && departmentChoices.length) return departmentChoices;
    return lookups[f.name] ?? 'loading';
  }

  function toggleField(f: FilterFieldDef) {
    setDraft((d) => {
      if (d[f.name]) {
        const { [f.name]: _gone, ...rest } = d;
        return rest;
      }
      return {
        ...d,
        [f.name]: {
          field: f.name,
          operatorId: f.operators[0].operatorId,
          values: [],
        },
      };
    });
    if (f.kind === 'lookup' && !(f.lookupModule === 'department' && departmentChoices.length) && !lookups[f.name] && f.lookupModule) {
      setLookups((l) => ({ ...l, [f.name]: 'loading' }));
      void fetchLookupOptions(f.lookupModule).then((rows) => setLookups((l) => ({ ...l, [f.name]: rows ?? 'failed' })));
    }
  }

  const setOp = (name: string, operatorId: number) => setDraft((d) => ({ ...d, [name]: { ...d[name], operatorId } }));
  const setText = (name: string, text: string) => setDraft((d) => ({ ...d, [name]: { ...d[name], values: [text] } }));
  const toggleValue = (name: string, v: string) =>
    setDraft((d) => {
      const cur = d[name].values;
      return {
        ...d,
        [name]: {
          ...d[name],
          values: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v],
        },
      };
    });

  return (
    <div className={styles.panel} ref={panelRef} role="dialog" aria-label="Filter people">
      <div className={styles.fieldSearch}>
        <div className={styles.fieldSearchBox}>
          <SearchIcon />
          <input
            id="people-filter-field-search"
            className={styles.fieldSearchInput}
            type="search"
            placeholder="Search fields"
            value={fieldQuery}
            onChange={(e) => setFieldQuery(e.target.value)}
            aria-label="Search fields"
          />
        </div>
      </div>

      <div className={styles.fields}>
        {shown.length === 0 && <p className={styles.none}>No field matches “{fieldQuery.trim()}”.</p>}
        {shown.map((f) => {
          const spec = draft[f.name];
          const on = !!spec;
          const op = on ? f.operators.find((o) => o.operatorId === spec.operatorId) : undefined;
          return (
            <div key={f.name} className={[styles.field, on ? styles.fieldOn : ''].join(' ')}>
              <button type="button" className={styles.fieldHead} onClick={() => toggleField(f)} aria-expanded={on}>
                <Check on={on} />
                <span className={styles.fieldLabel}>{f.label}</span>
              </button>
              {on && (
                <div className={styles.editor}>
                  {f.operators.length > 1 && (
                    <div className={styles.ops} role="group" aria-label={`${f.label} operator`}>
                      {f.operators.map((o) => (
                        <button
                          key={o.operatorId}
                          type="button"
                          className={styles.op}
                          aria-pressed={o.operatorId === spec.operatorId}
                          onClick={() => setOp(f.name, o.operatorId)}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {op?.valueNeeded !== false &&
                    (f.kind === 'text' ? (
                      <input
                        id={`people-filter-${f.name}`}
                        className={styles.textValue}
                        type="text"
                        placeholder="Value"
                        value={spec.values[0] ?? ''}
                        onChange={(e) => setText(f.name, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onApply(completeFilters(Object.values(draft), fields));
                        }}
                      />
                    ) : (
                      <ChoiceList name={f.name} label={f.label} choices={choicesFor(f)} selected={spec.values} onToggle={(v) => toggleValue(f.name, v)} />
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.foot}>
        <button type="button" className={styles.clearAll} disabled={!hasAnything} onClick={() => onApply([])}>
          Clear all
        </button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onApply(completeFilters(draftList, fields))}>
          Apply
        </Button>
      </div>
    </div>
  );
}

function ChoiceList({
  name,
  label,
  choices,
  selected,
  onToggle,
}: {
  name: string;
  label: string;
  choices: LookupChoice[] | 'loading' | 'failed';
  selected: string[];
  onToggle: (v: string) => void;
}) {
  const [q, setQ] = useState('');
  if (choices === 'loading') return <p className={styles.none}>Loading {label.toLowerCase()}…</p>;
  if (choices === 'failed') return <p className={styles.none}>Couldn’t load the {label.toLowerCase()} list. Close and try again.</p>;
  if (!choices.length) return <p className={styles.none}>No {label.toLowerCase()} to choose from.</p>;
  const needle = q.trim().toLowerCase();
  const visible = needle ? choices.filter((c) => c.label.toLowerCase().includes(needle)) : choices;
  return (
    <div className={styles.choices}>
      {choices.length > SEARCH_CHOICES_OVER && (
        <input
          id={`people-filter-${name}-search`}
          className={styles.choiceSearch}
          type="search"
          placeholder={`Search ${label.toLowerCase()}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={`Search ${label}`}
        />
      )}
      <div className={styles.choiceList} role="group" aria-label={label}>
        {visible.map((c) => {
          const on = selected.includes(c.value);
          return (
            <button
              key={c.value}
              type="button"
              className={[styles.choice, on ? styles.choiceOn : ''].join(' ')}
              aria-pressed={on}
              onClick={() => onToggle(c.value)}
            >
              <Check on={on} small />
              {c.color && <span className={styles.dot} style={{ background: c.color }} />}
              <span className={styles.choiceLabel}>{c.label}</span>
            </button>
          );
        })}
        {visible.length === 0 && <p className={styles.none}>Nothing matches “{q.trim()}”.</p>}
      </div>
    </div>
  );
}

function Check({ on, small }: { on: boolean; small?: boolean }) {
  return (
    <span className={[styles.check, on ? styles.checkOn : '', small ? styles.checkSmall : ''].join(' ')} aria-hidden>
      {on && (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
    </span>
  );
}

function SearchIcon() {
  return (
    <svg
      className={styles.searchIcon}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5h18l-7 8v5l-4 2v-7z" />
    </svg>
  );
}
