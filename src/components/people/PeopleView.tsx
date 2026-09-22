import { useEffect, useMemo, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { initials, visibleUnits } from '../../state/selectors';
import { facilioRecordUrl, isFacilioApiConfigured } from '../../lib/facilioApi';
import { searchEmployees } from '../../lib/facilioApiDataSource';
import type { Employee } from '../../lib/types';
import styles from './PeopleView.module.css';

/** Simple directory of employees. Assigned desks are derived from `state.assignments`. */
export function PeopleView() {
  const { state } = useFloorplan();
  const [search, setSearch] = useState('');

  const deskByContact = useMemo(() => {
    const map: Record<string, string> = {};
    // Only units whose module is switched on — the directory shouldn't name a desk or stall that
    // no longer appears anywhere else in the app.
    const units = visibleUnits(state);
    for (const [unitId, contactId] of Object.entries(state.assignments)) {
      const u = units.find((x) => x.id === unitId);
      if (u) map[contactId] = u.label;
    }
    return map;
  }, [state.assignments, state.units, state.enabledModules]);

  /**
   * Matching happens in two places on purpose. Locally, against everything the roster carries —
   * HRMS Employee ID, name, email, department — so typing is answered on the keystroke. And at the
   * ORG, because the roster in memory is only what was loaded, and a person the search can't see
   * is indistinguishable from a person who doesn't exist.
   *
   * The server's answer replaces the local one when it arrives; a failed or unconfigured call
   * leaves the local match standing rather than emptying the list.
   */
  const [remote, setRemote] = useState<Employee[] | null>(null);
  useEffect(() => {
    const q = search.trim();
    setRemote(null);
    if (!q || !isFacilioApiConfigured) return;
    let live = true;
    const t = setTimeout(() => {
      void searchEmployees(q).then((rows) => {
        if (live && rows) setRemote(rows);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [search]);

  const q = search.trim().toLowerCase();
  const localMatches = state.employees.filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      (c.hrmsEmployeeId ?? '').toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (c.department ?? '').toLowerCase().includes(q),
  );
  const people = (remote ?? localMatches).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <h1 className={styles.h1}>People</h1>
            <p className={styles.sub}>{state.employees.length} people in this workspace</p>
          </div>
          <input
            className={styles.search}
            placeholder="Search by name, HRMS Employee ID, email or department"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {people.length === 0 ? (
          <div className={styles.empty}>No people match “{search}”.</div>
        ) : (
          <div className={styles.list}>
            {people.map((c) => {
              const real = /^\d+$/.test(c.id) ? facilioRecordUrl('employee', c.id) : null;
              const desk = deskByContact[c.id];
              return (
                <div key={c.id} className={styles.row}>
                  <span className={styles.avatar}>{initials(c.name) || '·'}</span>
                  <div className={styles.meta}>
                    <span className={styles.name}>{c.name}</span>
                    {(c.hrmsEmployeeId || c.department || c.email) && (
                      <span className={styles.rowSub}>{[c.hrmsEmployeeId, c.department, c.email].filter(Boolean).join(' · ')}</span>
                    )}
                  </div>
                  {desk && <span className={styles.deskPill}>{desk}</span>}
                  {real && (
                    <a className={styles.openLink} href={real} target="_blank" rel="noreferrer" data-tip="Open record in Facilio">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <path d="M15 3h6v6M10 14L21 3" />
                      </svg>
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
