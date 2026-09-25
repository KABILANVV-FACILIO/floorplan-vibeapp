import { useEffect, useState } from 'react';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { fetchEmployees, queryEmployees } from '../lib/facilioApiDataSource';
import { completeFilters, matchesLocally } from '../lib/employeeFilters';
import type { AppliedFilter, FilterFieldDef } from '../lib/employeeFilters';
import type { Employee } from '../lib/types';

/**
 * The people a surface should show, read from the org rather than from the boot-time roster.
 *
 * `state.employees` is fetched once when the app starts and never again. That was tolerable while
 * everything matched in the browser; it stopped being tolerable once search went to the API, which
 * made it possible to FIND someone the list beside it did not contain. Anything showing people now
 * asks the org when it opens, and asks again — filtered — as the user types.
 *
 * The roster in state stays as the floor: it is what the marker initials, the "Assigned · …" pills
 * and the drag-to-assign list resolve names against, and it is available before this read lands.
 * So this returns `fallback` until the org answers, and returns it again if the org cannot be
 * reached — a picker that empties itself because a network call failed is worse than a slightly
 * old list.
 */
export function useLivePeople(
  query: string,
  fallback: Employee[],
  opts?: {
    enabled?: boolean;
    /** The filter panel's ticked fields (People sidebar only). Sent in the same request as the search. */
    filters?: AppliedFilter[];
    filterFields?: FilterFieldDef[];
  },
): { people: Employee[]; loading: boolean; failed: boolean } {
  const enabled = opts?.enabled ?? true;
  const fields = opts?.filterFields ?? [];
  const applied = completeFilters(opts?.filters ?? [], fields);
  // A stable key for the effect: the filters as they will be sent.
  const filterKey = JSON.stringify(applied);
  const [roster, setRoster] = useState<Employee[] | null>(null);
  const [hits, setHits] = useState<Employee[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  // The list as it stands, refreshed each time the surface opens.
  useEffect(() => {
    if (!enabled || !isFacilioApiConfigured) return;
    let live = true;
    setLoading(true);
    void fetchEmployees()
      .then((rows) => {
        if (live && rows) setRoster(rows);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled]);

  // And filtered at the org while typing, or whenever the filter panel narrows the list — search
  // and filters go out as ONE request, so a match outside the first page is still reachable.
  useEffect(() => {
    const q = query.trim();
    setHits(null);
    setFailed(false);
    if (!enabled || (!q && applied.length === 0) || !isFacilioApiConfigured) return;
    let live = true;
    const t = setTimeout(() => {
      void queryEmployees({ query: q, applied, fields }).then((rows) => {
        if (!live) return;
        if (rows) setHits(rows);
        else setFailed(true);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `applied`/`fields` are read through filterKey, their serialized form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, enabled, filterKey]);

  const base = roster ?? fallback;
  const q = query.trim().toLowerCase();
  const matchesQuery = (c: Employee) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    (c.hrmsEmployeeId ?? '').toLowerCase().includes(q) ||
    (c.email ?? '').toLowerCase().includes(q) ||
    (c.department ?? '').toLowerCase().includes(q);
  const local = base.filter((c) => matchesQuery(c) && (isFacilioApiConfigured || matchesLocally(c, applied, fields)));

  if (applied.length && isFacilioApiConfigured) {
    // Filters are the org's to apply — department is matched by record id, which the roster in
    // hand can't check. So there is no local stand-in here: until the org answers, the list is
    // loading, and if it can't answer, it says so. Showing the unfiltered roster under a
    // "Filter · 2" button would read as the filter's result.
    return { people: hits ?? [], loading: hits === null && !failed, failed };
  }
  // Search alone: the local match answers the keystroke, and the org's answer replaces it.
  return { people: hits ?? local, loading: loading && roster === null, failed: false };
}
