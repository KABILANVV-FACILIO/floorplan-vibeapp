import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, initials, isAssignable, unitById, visibleUnits } from '../../state/selectors';
import { TYPE_META } from '../../lib/types';
import type { Unit } from '../../lib/types';
import { facilioRecordUrl, isFacilioApiConfigured } from '../../lib/facilioApi';
import { fetchEmployeeFilterFields } from '../../lib/facilioApiDataSource';
import { DEMO_FILTER_FIELDS } from '../../lib/employeeFilters';
import type { AppliedFilter, FilterFieldDef } from '../../lib/employeeFilters';
import { departmentColor, departmentKey, departmentsIn } from '../../lib/departmentColors';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { SkeletonBlock, SkeletonRows } from '../primitives/Skeleton';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';
import { useLivePeople } from '../../hooks/useLivePeople';
import { LocalAssign } from './LocalAssign';
import { StateflowActions } from './StateflowActions';
import { FilterIcon, PeopleFilterPanel } from './PeopleFilterPanel';
import type { LookupChoice } from './PeopleFilterPanel';
import card from './Card.module.css';
import styles from './AssignPanel.module.css';

export function AssignPanel() {
  const { state, actions } = useFloorplan();
  const sel = unitById(state, state.selected);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);

  // The org's own list, filtered AT THE ORG as you type — the same read the People page and the
  // assign picker make. This panel used to match `state.employees` in the browser, so typing here
  // sent nothing to the API: a person outside the roster loaded at boot was unfindable from the
  // one list that sits beside the plan.
  //
  // The Filter panel narrows the same request: its ticked fields go out in the SAME `filters`
  // payload as the search (see employeeFilters.buildEmployeeFilters). Session-only, this surface
  // only — the People page and the assign picker keep their plain search.
  const [filters, setFilters] = useState<AppliedFilter[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterFields, setFilterFields] = useState<FilterFieldDef[] | null>(null);
  useEffect(() => {
    if (!isFacilioApiConfigured) {
      setFilterFields(DEMO_FILTER_FIELDS);
      return;
    }
    let live = true;
    void fetchEmployeeFilterFields().then((f) => {
      if (live) setFilterFields(f ?? []);
    });
    return () => {
      live = false;
    };
  }, []);
  const {
    people: contacts,
    loading: peopleLoading,
    failed: filterFailed,
  } = useLivePeople(state.contactSearch, state.employees, { filters, filterFields: filterFields ?? [] });

  // Department colours exactly as the plan draws them: the same function, fed the same ids.
  const planDeptIds = useMemo(() => departmentsIn(state.units).map((d) => d.id), [state.units]);
  const deptIdByName = useMemo(() => new Map(state.departments.map((d) => [departmentKey(d.name), d.id])), [state.departments]);
  const deptColorForName = (name?: string) => {
    if (!name) return undefined;
    return departmentColor(deptIdByName.get(departmentKey(name)) ?? 'name:' + departmentKey(name), state.departmentColors, planDeptIds);
  };
  const departmentChoices: LookupChoice[] = useMemo(() => {
    if (state.departments.length) {
      return [...state.departments]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ value: d.id, label: d.name, color: departmentColor(d.id, state.departmentColors, planDeptIds) }));
    }
    // Against the org, department values must be record ids (PickListOperators match ids). If the
    // department list didn't load at boot, answer nothing here and let the panel read the
    // department records itself (fetchLookupOptions), rather than offer names the org can't match.
    if (isFacilioApiConfigured) return [];
    // The demo roster has department names but no department records: filter by name.
    const names = [...new Set(state.employees.map((e) => e.department).filter((n): n is string => !!n))].sort();
    return names.map((n) => ({ value: n, label: n, color: departmentColor('name:' + departmentKey(n), state.departmentColors, planDeptIds) }));
  }, [state.departments, state.employees, state.departmentColors, planDeptIds]);
  const activeFilters = filters.length;
  const filtersUsable = !!filterFields && filterFields.length > 0;

  // A disabled module leaves no trace anywhere, so a holding of one is not listed against the
  // person either — it would name a unit the rest of the app has stopped showing.
  function unitsHeldBy(contactId: string) {
    return visibleUnits(state).filter((u) => state.assignments[u.id] === contactId).map((u) => u.label);
  }

  function onDragStart(e: ReactDragEvent, contactId: string, name: string) {
    e.dataTransfer.setData('text/plain', contactId);
    e.dataTransfer.effectAllowed = 'move';

    const ghost = document.createElement('div');
    ghost.textContent = initials(name);
    Object.assign(ghost.style, {
      position: 'fixed',
      top: '-1000px',
      left: '-1000px',
      width: '40px',
      height: '40px',
      borderRadius: '999px',
      background: 'var(--blue-500)',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '600 13px/1 var(--font-sans)',
      boxShadow: '0 4px 12px rgba(40,54,72,0.3)',
    } as CSSStyleDeclaration);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 20, 20);
    dragGhostRef.current = ghost;

    setDragId(contactId);
    actions.dragStartContact(contactId);
  }
  function onDragEnd() {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
    setDragId(null);
    actions.dragStartContact(null);
  }

  return (
    <div className={styles.stack}>
      {sel && sel.type !== 'amenity' && (
        <div className={card.card}>
          <div className={card.cardHead}>
            <h3 className={card.cardTitle}>
              {sel.label} <span className={styles.typeTag}>{TYPE_META[sel.type].name}</span>
            </h3>
          </div>
          <div className={card.cardBody}>
            {isAssignable(sel) ? (
              <>
                <Holder unitId={sel.id} />
                {/* The same buttons the plan's popover offers — the org's flow decides them, so
                    the two surfaces must not disagree about what you can do to this record, and
                    Assign/Allocate open the people picker here exactly as they do there. The
                    app's own controls stand in only where the org offers no flow at all. */}
                <StateflowActions unit={sel} fallback={<LocalAssign unit={sel} />} />
              </>
            ) : (
              // A space that is booked rather than assigned has nobody to show here, but it still
              // has the org's transitions — the same ones its popover offers.
              <StateflowActions unit={sel} />
            )}
          </div>
        </div>
      )}
      {sel && sel.type === 'amenity' && (
        <div className={card.card}>
          <div className={card.cardHead}>
            <h3 className={card.cardTitle}>{sel.label}</h3>
          </div>
          <div className={card.cardBody}>
            {sel.secondary && <p className={card.helper}>{sel.secondary}</p>}
          </div>
        </div>
      )}
      {!sel && (
        <div className={card.card}>
          <div className={card.cardBody}>
            <p className={card.helper}>Select a desk, locker, or parking stall on the plan to assign it.</p>
          </div>
        </div>
      )}

      <div className={[card.card, styles.peopleCard].join(' ')}>
        <div className={card.cardHead}>
          <h3 className={card.cardTitle}>People</h3>
        </div>
        <div className={styles.peopleSearchWrap}>
          <div className={styles.peopleToolbar}>
            <input
              id="people-search"
              className={card.input}
              placeholder="Name, HRMS ID or email"
              aria-label="Search people by name, HRMS ID or email"
              value={state.contactSearch}
              onChange={(e) => actions.setContactSearch(e.target.value)}
            />
            <button
              type="button"
              className={[styles.filterBtn, activeFilters || filterOpen ? styles.filterBtnOn : ''].join(' ')}
              aria-expanded={filterOpen}
              aria-label={activeFilters ? `Filter, ${activeFilters} applied` : 'Filter'}
              disabled={!filtersUsable}
              data-tip={filterFields === null ? 'Loading filters…' : !filtersUsable ? 'Filters aren’t available for this org' : undefined}
              onClick={() => setFilterOpen((o) => !o)}
            >
              <FilterIcon />
              Filter
              {activeFilters > 0 && <span className={styles.filterBadge}>{activeFilters}</span>}
            </button>
          </div>
          <p className={styles.dragHint}>Drag a person onto a desk, locker, or parking stall to assign it.</p>
        </div>
        <div className={styles.peopleBody}>
          <div className={styles.peopleList}>
            {((state.loading && state.employees.length === 0) || (activeFilters > 0 && peopleLoading)) && <SkeletonRows rows={6} avatar />}
            {activeFilters > 0 && filterFailed && (
              <div className={styles.listNote}>
                <b>Couldn’t filter people right now.</b>
                <span>Try again in a moment, or clear the filters.</span>
                <button type="button" className={styles.linkBtn} onClick={() => setFilters([])}>
                  Clear filters
                </button>
              </div>
            )}
            {activeFilters > 0 && !peopleLoading && !filterFailed && contacts.length === 0 && (
              <div className={styles.listNote}>
                <b>No one matches these filters.</b>
                <span>Change them, or clear them to see everyone.</span>
                <button type="button" className={styles.linkBtn} onClick={() => setFilters([])}>
                  Clear filters
                </button>
              </div>
            )}
            {contacts.map((contact) => {
              const held = unitsHeldBy(contact.id);
              // Mock demo ids look like "c1".."c14" and have no real record to open — only
              // real (numeric) employee ids from the real backend get a working summary-page link.
              const recordUrl = /^\d+$/.test(contact.id) ? facilioRecordUrl('employee', contact.id) : null;
              return (
                <div
                  key={contact.id}
                  className={styles.personRow}
                  draggable
                  onDragStart={(e) => onDragStart(e, contact.id, contact.name)}
                  onDragEnd={onDragEnd}
                  onClick={() => recordUrl && window.open(recordUrl, '_blank', 'noopener,noreferrer')}
                  style={{ opacity: dragId === contact.id ? 0.45 : 1, cursor: recordUrl ? 'pointer' : 'grab' }}
                  data-tip={recordUrl ? 'Open employee record' : undefined}
                >
                  <span className={styles.avatar}>
                    {initials(contact.name)}
                    {contact.department && <span className={styles.deptDot} style={{ background: deptColorForName(contact.department) }} />}
                  </span>
                  <div className={styles.personText}>
                    <div className={styles.personName}>{contact.name}</div>
                    {(contact.hrmsEmployeeId || contact.department) && (
                      <div className={styles.personSub}>{[contact.hrmsEmployeeId, contact.department].filter(Boolean).join(' · ')}</div>
                    )}
                  </div>
                  {held.length > 0 && <span className={styles.heldBadge}>{held.join(', ')}</span>}
                  {recordUrl && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.openIcon}>
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <path d="M15 3h6v6M10 14L21 3" />
                    </svg>
                  )}
                </div>
              );
            })}
          </div>
          {filterOpen && filterFields && (
            <PeopleFilterPanel
              fields={filterFields}
              applied={filters}
              departmentChoices={departmentChoices}
              onApply={(next) => {
                setFilters(next);
                setFilterOpen(false);
              }}
              onClose={() => setFilterOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Who the org says holds this record — the same thing the popover leads with. */
function Holder({ unitId }: { unitId: string }) {
  const { state } = useFloorplan();
  const contactId = state.assignments[unitId];
  // A write is in flight against THIS record, so who holds it is precisely what is changing —
  // the same rule the popover follows. Showing the outgoing holder until the write lands makes
  // the panel look like it ignored the button you pressed.
  const busy = state.busyUnitId === unitId;
  const showShimmer = useDelayedFlag(busy, { key: unitId, sticky: false });

  if (busy) {
    return (
      <div className={styles.assignedRow}>
        {showShimmer ? (
          <>
            <SkeletonBlock width={28} height={28} />
            <SkeletonBlock width={132} height={15} radius={4} />
          </>
        ) : (
          <span style={{ display: 'inline-block', height: 28 }} />
        )}
      </div>
    );
  }

  if (!contactId) return null;
  return (
    <div className={styles.assignedRow}>
      <span className={styles.avatar}>{initials(contactName(state, contactId))}</span>
      <span className={styles.assignedName}>{contactName(state, contactId)}</span>
    </div>
  );
}
