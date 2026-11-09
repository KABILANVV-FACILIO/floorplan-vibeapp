import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { contactName, initials, isAssignable, unitById, visibleUnits } from '../../state/selectors';
import { byDepartmentName, departmentDisplayName, employeeNumber, personDisplayName } from '../../lib/displayNames';
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
import { FilterIcon, LookupChoices, PeopleFilterPanel } from './PeopleFilterPanel';
import type { LookupChoice } from './PeopleFilterPanel';
import card from './Card.module.css';
import styles from './AssignPanel.module.css';

/**
 * The Assignment view's side panel: the selected space, then the People list. Without the
 * Assignment right (Roles & access › Floorplans) it is the same panel read-only — who holds the
 * space, and a People list to search and filter, with nothing to assign and nothing to drag.
 */
export function AssignPanel() {
  const { state } = useFloorplanData();
  const sel = unitById(state, state.selected);
  const assignOn = state.planViews.assign;

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
                {assignOn ? <StateflowActions unit={sel} fallback={<LocalAssign unit={sel} />} /> : !state.assignments[sel.id] && <p className={card.helper}>Nobody holds this.</p>}
              </>
            ) : (
              // A space that is booked rather than assigned has nobody to show here, but it still
              // has the org's transitions — the same ones its popover offers.
              assignOn && <StateflowActions unit={sel} />
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
            <p className={card.helper}>{assignOn ? 'Select a desk, locker, or parking stall on the plan to assign it.' : 'Select a desk, locker, or parking stall on the plan to see who holds it.'}</p>
          </div>
        </div>
      )}

      <PeopleCard />
    </div>
  );
}

/**
 * The People list: search, a Department picker and the Filter panel, over the org's own list.
 * People are dragged onto the plan to assign them only with the Assignment right; without it the
 * list is for finding people — rows open the employee record, and nothing drags.
 */
export function PeopleCard({ fixed = false }: { /** A set height, for a panel that scrolls as a whole (the Booking view's). */ fixed?: boolean } = {}) {
  const { state, actions } = useFloorplanData();
  const assignOn = state.planViews.assign;
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
        .sort(byDepartmentName)
        .map((d) => ({ value: d.id, label: departmentDisplayName(d.name), color: departmentColor(d.id, state.departmentColors, planDeptIds) }));
    }
    // Against the org, department values must be record ids (PickListOperators match ids). The
    // panel lists them from the org's picklist; these only lend it their plan colours. Without
    // the department list there are no colours, never names the org can't match.
    if (isFacilioApiConfigured) return [];
    // The demo roster has department names but no department records: filter by name.
    const names = [...new Set(state.employees.map((e) => e.department).filter((n): n is string => !!n))].sort();
    return names.map((n) => ({ value: n, label: departmentDisplayName(n), color: departmentColor('name:' + departmentKey(n), state.departmentColors, planDeptIds) }));
  }, [state.departments, state.employees, state.departmentColors, planDeptIds]);
  const activeFilters = filters.length;
  const filtersUsable = !!filterFields && filterFields.length > 0;

  /**
   * The Department picker under the search — the org's own Department field, so it is the SAME
   * filter the Filter panel ticks ("Department is …"): one entry in `filters`, one request, one
   * count on the Filter button. Ticking applies at once; there is nothing to confirm.
   */
  const deptField = filterFields?.find((f) => f.kind === 'lookup' && (f.lookupModule === 'department' || f.name === 'department')) ?? null;
  const [deptOpen, setDeptOpen] = useState(false);
  const deptFilter = deptField ? filters.find((f) => f.field === deptField.name) : undefined;
  // "Department isn't …" can only be set in the Filter panel; the picker shows "is" alone.
  const deptPicked = deptFilter && deptFilter.operatorId === 36 ? deptFilter.values : [];
  const deptColor = useMemo(() => new Map(departmentChoices.map((c) => [c.value, c.color])), [departmentChoices]);
  const deptName = (v: string) => deptFilter?.labels?.[v] ?? departmentChoices.find((c) => c.value === v)?.label ?? v;
  function toggleDepartment(v: string, label: string) {
    if (!deptField) return;
    const values = deptPicked.includes(v) ? deptPicked.filter((x) => x !== v) : [...deptPicked, v];
    const rest = filters.filter((f) => f.field !== deptField.name);
    setFilters(values.length ? [...rest, { field: deptField.name, operatorId: 36, values, labels: { ...(deptFilter?.labels ?? {}), [v]: label } }] : rest);
  }
  function clearDepartments() {
    if (deptField) setFilters(filters.filter((f) => f.field !== deptField.name));
  }

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
    <div className={[card.card, styles.peopleCard, fixed ? styles.peopleCardFixed : ''].join(' ')}>
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
            onClick={() => {
              setFilterOpen((o) => !o);
              setDeptOpen(false);
            }}
          >
            <FilterIcon />
            Filter
            {activeFilters > 0 && <span className={styles.filterBadge}>{activeFilters}</span>}
          </button>
        </div>
        {deptField && (
          <button
            type="button"
            className={[styles.deptBtn, deptPicked.length || deptOpen ? styles.deptBtnOn : ''].join(' ')}
            aria-expanded={deptOpen}
            onClick={() => {
              setDeptOpen((o) => !o);
              setFilterOpen(false);
            }}
          >
            <span className={styles.deptBtnLabel}>Department</span>
            <span className={styles.deptBtnValue}>
              {deptPicked.length === 0
                ? 'All'
                : deptPicked.length === 1
                  ? departmentDisplayName(deptName(deptPicked[0])) || deptName(deptPicked[0])
                  : `${departmentDisplayName(deptName(deptPicked[0])) || deptName(deptPicked[0])} +${deptPicked.length - 1}`}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ transform: deptOpen ? 'rotate(180deg)' : undefined }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
        {deptField && deptOpen && (
          <div className={styles.deptPicker}>
            <LookupChoices
              field={deptField}
              selected={deptPicked}
              labels={deptFilter?.labels}
              colorOf={(id) => deptColor.get(id)}
              localChoices={departmentChoices}
              onToggle={toggleDepartment}
            />
            <div className={styles.deptPickerFoot}>
              {deptPicked.length > 0 ? (
                <button type="button" className={styles.linkBtn} onClick={clearDepartments}>
                  Show all departments
                </button>
              ) : (
                <span />
              )}
              <button type="button" className={styles.linkBtn} onClick={() => setDeptOpen(false)}>
                Done
              </button>
            </div>
          </div>
        )}
        {assignOn && <p className={styles.dragHint}>Drag a person onto a desk, locker, or parking stall to assign it.</p>}
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
                // Dragging a person onto a desk IS assigning them, so without the right nothing drags.
                draggable={assignOn}
                onDragStart={assignOn ? (e) => onDragStart(e, contact.id, contact.name) : undefined}
                onDragEnd={assignOn ? onDragEnd : undefined}
                onClick={() => recordUrl && window.open(recordUrl, '_blank', 'noopener,noreferrer')}
                style={{ opacity: dragId === contact.id ? 0.45 : 1, cursor: recordUrl ? 'pointer' : assignOn ? 'grab' : 'default' }}
                data-tip={recordUrl ? 'Open employee record' : undefined}
              >
                <span className={styles.avatar}>
                  {initials(contact.name)}
                  {contact.department && <span className={styles.deptDot} style={{ background: deptColorForName(contact.department) }} />}
                </span>
                <div className={styles.personText}>
                  <div className={styles.personName}>{personDisplayName(contact.name)}</div>
                  {(employeeNumber(contact) || contact.department) && (
                    <div className={styles.personSub}>{[employeeNumber(contact), departmentDisplayName(contact.department)].filter(Boolean).join(' · ')}</div>
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
  );
}

/** Who the org says holds this record — the same thing the popover leads with. */
function Holder({ unitId }: { unitId: string }) {
  const { state } = useFloorplanData();
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
