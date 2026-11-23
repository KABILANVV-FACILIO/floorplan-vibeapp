import { useCallback, useEffect, useState } from 'react';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { queryEmployees } from '../lib/facilioApiDataSource';
import { completeFilters, matchesLocally } from '../lib/employeeFilters';
import type { AppliedFilter, FilterFieldDef } from '../lib/employeeFilters';
import type { Employee } from '../lib/types';

/**
 * The people a surface should show: the roster in hand, and the org's own answer for whatever is
 * typed or filtered.
 *
 * With nothing typed the list IS `roster` — the app's roster (`state.employees`), read at boot and
 * again on Refresh. Each surface used to read the org's employee list itself as it opened, and
 * then show that one page in place of the roster: five surfaces, one request per open, for people
 * already in hand — and in an org of ~2,600 the People page read "200 people". Nothing is asked
 * until something is typed.
 *
 * Typing still asks the org, filtered there and debounced, so a person outside the roster is still
 * findable; the local match answers the keystroke until the org does. Those results are this
 * surface's alone — they never replace the roster.
 *
 * What it says besides the list: `loading` while a filtered read is on its way and nothing can
 * stand in for it; `loadFailed` when the search typed (or the filters ticked) could not be made, so
 * a surface can say so rather than guess it from an empty list; `failed`, the same for the filter
 * panel's read (the People list beside the plan); and `retry()`, which asks the org again. A roster
 * that could not be read at boot is the app's to re-read (Refresh) — this does not fetch it.
 */
export function useLivePeople(
  query: string,
  roster: Employee[],
  opts?: {
    enabled?: boolean;
    /** The filter panel's ticked fields (People sidebar only). Sent in the same request as the search. */
    filters?: AppliedFilter[];
    filterFields?: FilterFieldDef[];
    /**
     * The roster's own read (state.rosterStatus) and the way to ask again (actions.reloadRoster):
     * with nothing typed an empty roster then reads as loading, or as not loaded with Retry — never
     * as "no people in this org".
     */
    rosterStatus?: 'loading' | 'ready' | 'failed';
    reloadRoster?: () => void;
  },
): { people: Employee[]; loading: boolean; failed: boolean; loadFailed: boolean; retry: () => void } {
  const enabled = opts?.enabled ?? true;
  const fields = opts?.filterFields ?? [];
  const applied = completeFilters(opts?.filters ?? [], fields);
  // A stable key for the effect: the filters as they will be sent.
  const filterKey = JSON.stringify(applied);
  const [hits, setHits] = useState<Employee[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped by retry(): the search below runs again.
  const [attempt, setAttempt] = useState(0);
  const reloadRoster = opts?.reloadRoster;
  const searching = query.trim().length > 0;
  const retry = useCallback(() => {
    if (!searching && reloadRoster) reloadRoster();
    else setAttempt((a) => a + 1);
  }, [searching, reloadRoster]);

  // Filtered at the org while typing, or whenever the filter panel narrows the list — search and
  // filters go out as ONE request, so a match outside the roster in hand is still reachable.
  useEffect(() => {
    const q = query.trim();
    setHits(null);
    setFailed(false);
    if (!enabled || (!q && applied.length === 0) || !isFacilioApiConfigured) return;
    let live = true;
    const t = setTimeout(() => {
      void queryEmployees({ query: q, applied, fields }).then(
        (rows) => {
          if (!live) return;
          if (rows) setHits(rows);
          else setFailed(true);
        },
        () => live && setFailed(true),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `applied`/`fields` are read through filterKey, their serialized form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, enabled, filterKey, attempt]);

  const q = query.trim().toLowerCase();
  const matchesQuery = (c: Employee) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    (c.hrmsEmployeeId ?? '').toLowerCase().includes(q) ||
    (c.email ?? '').toLowerCase().includes(q) ||
    (c.department ?? '').toLowerCase().includes(q);
  const local = roster.filter((c) => matchesQuery(c) && (isFacilioApiConfigured || matchesLocally(c, applied, fields)));

  if (applied.length && isFacilioApiConfigured) {
    // Filters are the org's to apply — department is matched by record id, which the roster in
    // hand can't check. So there is no local stand-in here: until the org answers, the list is
    // loading, and if it can't answer, it says so. Showing the unfiltered roster under a
    // "Filter · 2" button would read as the filter's result.
    return { people: hits ?? [], loading: hits === null && !failed, failed, loadFailed: failed, retry };
  }
  // Search alone: the local match answers the keystroke, and the org's answer replaces it. With
  // nothing typed the roster is the list: loading or not loaded only as the roster's own read is.
  if (!q) {
    const empty = roster.length === 0;
    return { people: local, loading: empty && opts?.rosterStatus === 'loading', failed: false, loadFailed: empty && opts?.rosterStatus === 'failed', retry };
  }
  return { people: hits ?? local, loading: false, failed: false, loadFailed: failed, retry };
}
