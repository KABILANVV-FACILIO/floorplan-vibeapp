import { useMemo, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { initials, visibleUnits } from '../../state/selectors';
import { byPersonName, departmentDisplayName, employeeNumber, personDisplayName } from '../../lib/displayNames';
import { facilioRecordUrl } from '../../lib/facilioApi';
import { useLivePeople } from '../../hooks/useLivePeople';
import { SkeletonRows } from '../primitives/Skeleton';
import styles from './PeopleView.module.css';

/**
 * Simple directory of employees. Assigned desks are derived from `state.assignments`.
 *
 * Nothing to show is told apart from nothing having arrived: shimmer rows while the org is asked,
 * "Couldn't load people · Retry" when a read failed and left nothing to show (useLivePeople says
 * so — it used to be guessed from an empty list), "No people match …" only for a search that was
 * typed, and "Couldn't search people · Retry" when that search itself failed.
 */
export function PeopleView() {
  const [search, setSearch] = useState('');
  const { state, actions } = useFloorplanData();

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

  // The roster the app holds (read at boot and on Refresh), and the org's own answer for what is
  // typed — opening the page asks nothing (see useLivePeople). Retry searches again; what was
  // typed stays.
  const { people: live, loading: waiting, loadFailed, retry } = useLivePeople(search, state.employees, { rosterStatus: state.rosterStatus, reloadRoster: actions.reloadRoster });
  const people = live.slice().sort(byPersonName);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <h1 className={styles.h1}>People</h1>
            <p className={styles.sub}>{waiting && people.length === 0 ? 'Loading people…' : `${people.length} people`}</p>
          </div>
          <input
            className={styles.search}
            placeholder="Search by name, HRMS Employee ID, email or department"
            aria-label="Search people by name, HRMS Employee ID, email or department"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {people.length === 0 && waiting ? (
          <div className={styles.list} aria-busy>
            <SkeletonRows rows={8} avatar />
          </div>
        ) : people.length === 0 && loadFailed ? (
          <div className={styles.empty} role="alert">
            {search.trim() ? 'Couldn’t search people.' : 'Couldn’t load people.'}{' '}
            <button type="button" className={styles.retry} onClick={retry}>
              Retry
            </button>
          </div>
        ) : people.length === 0 && search.trim() ? (
          <div className={styles.empty}>No people match “{search.trim()}”.</div>
        ) : people.length === 0 ? (
          <div className={styles.empty}>No people in this org yet.</div>
        ) : (
          <div className={styles.list}>
            {people.map((c) => {
              const real = /^\d+$/.test(c.id) ? facilioRecordUrl('employee', c.id) : null;
              const desk = deskByContact[c.id];
              return (
                <div key={c.id} className={styles.row}>
                  <span className={styles.avatar}>{initials(c.name) || '·'}</span>
                  <div className={styles.meta}>
                    <span className={styles.name}>{personDisplayName(c.name)}</span>
                    {(employeeNumber(c) || c.department || c.email) && (
                      <span className={styles.rowSub}>{[employeeNumber(c), departmentDisplayName(c.department), c.email].filter(Boolean).join(' · ')}</span>
                    )}
                  </div>
                  {desk && <span className={styles.deskPill}>{desk}</span>}
                  {real && (
                    <a className={styles.openLink} href={real} target="_blank" rel="noreferrer" data-tip="Open record in Facilio" aria-label={`Open ${personDisplayName(c.name)}'s record in Facilio`}>
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
