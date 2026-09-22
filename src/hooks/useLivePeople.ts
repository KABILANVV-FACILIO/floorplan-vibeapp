import { useEffect, useState } from 'react';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { fetchEmployees, searchEmployees } from '../lib/facilioApiDataSource';
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
export function useLivePeople(query: string, fallback: Employee[], opts?: { enabled?: boolean }): { people: Employee[]; loading: boolean } {
  const enabled = opts?.enabled ?? true;
  const [roster, setRoster] = useState<Employee[] | null>(null);
  const [hits, setHits] = useState<Employee[] | null>(null);
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

  // And filtered at the org while typing, so a match outside the first page is still reachable.
  useEffect(() => {
    const q = query.trim();
    setHits(null);
    if (!enabled || !q || !isFacilioApiConfigured) return;
    let live = true;
    const t = setTimeout(() => {
      void searchEmployees(q).then((rows) => {
        if (live && rows) setHits(rows);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, enabled]);

  const base = roster ?? fallback;
  const q = query.trim().toLowerCase();
  const local = q
    ? base.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.hrmsEmployeeId ?? '').toLowerCase().includes(q) ||
          (c.email ?? '').toLowerCase().includes(q) ||
          (c.department ?? '').toLowerCase().includes(q),
      )
    : base;

  // Local match answers the keystroke; the org's answer replaces it when it arrives.
  return { people: hits ?? local, loading: loading && roster === null };
}
