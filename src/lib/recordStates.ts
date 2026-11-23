/**
 * The state each desk, locker and stall record is in (its stateflow `moduleState`), as the floor's
 * own lists give it — the read that already says who holds each one, so knowing the states costs
 * no request of its own. ENEC's desks run Vacant / Occupied / Assigned / Temporarily Vacant /
 * Reserved / Checked Out / Inactive; its stalls Vacant / Occupied / Reserved. The occupancy card
 * splits the desks and stalls nobody holds by it (selectors.floorCounts).
 *
 * Kept by key, not by label: the state's own `status` ("temporarilyvacant"), which the org can't
 * rename the way it can the display name. A list read carries the state whole (the server adds it
 * to every list, FetchSysFields); a state with no status falls back to its name, folded the same
 * way ("Temporarily Vacant" -> "temporarilyvacant").
 *
 * Handed over the way a floor's read failures are (takeFloorReadFailure): the data source notes
 * the states as each page of the lists arrives, the context takes them after each read.
 */

/** A record's state folded to a key — lower case, letters only — or null when it has none. */
export function recordStateKey(moduleState: unknown): string | null {
  if (moduleState == null) return null;
  const raw =
    typeof moduleState === 'string'
      ? moduleState
      : typeof moduleState === 'object'
        ? ((moduleState as Record<string, unknown>).status ?? (moduleState as Record<string, unknown>).displayName ?? (moduleState as Record<string, unknown>).name)
        : null;
  if (typeof raw !== 'string') return null;
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  return key || null;
}

/** A desk the org has emptied for now — vacated, its holder gone, held open for their return. */
export function isTemporarilyVacant(key: string | null | undefined): boolean {
  return !!key && key.startsWith('temporar');
}

/** A record set aside without being taken (a reserved stall). */
export function isReserved(key: string | null | undefined): boolean {
  return !!key && key.startsWith('reserv');
}

const noted = new Map<string, Record<string, string>>();

/** Note the states of a page of a floor's records (each `{ id, moduleState }`), keyed by record id. */
export function noteRecordStates(floorId: string, records: Array<{ id?: unknown; moduleState?: unknown; state?: unknown }>): void {
  const into = noted.get(floorId) ?? {};
  for (const r of records) {
    if (r?.id == null) continue;
    const key = recordStateKey(r.moduleState ?? r.state);
    if (key) into[String(r.id)] = key;
  }
  noted.set(floorId, into);
}

/**
 * Forget what was noted for this floor and not taken — called as a read of the floor starts, so a
 * read that failed before the context took its states leaves none behind to be mixed into the next.
 */
export function clearRecordStates(floorId: string): void {
  noted.delete(floorId);
}

/** The states noted for this floor since it was last asked, then forgotten. */
export function takeRecordStates(floorId: string): Record<string, string> {
  const out = noted.get(floorId) ?? {};
  noted.delete(floorId);
  return out;
}
