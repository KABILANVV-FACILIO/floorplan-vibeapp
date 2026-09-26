import { getHostUrlProps, isConnectedApp, pushHostUrlProps, urlLog } from './facilioApi';

/**
 * The floor on screen, kept in the URL as `?floorId=` so a link or a reload opens on it.
 *
 * Inside Facilio that is the HOST page's URL (the address bar the user actually sees and shares),
 * read and written through the connected-app `getUrlProps` / `pushUrlProps` actions. Opened on its
 * own, the app keeps it on its own URL instead, so the same link works and the boot path can be
 * exercised without a host.
 */
export const URL_FLOOR_KEY = 'floorId';

export async function readUrlFloorId(): Promise<string | null> {
  urlLog(`reading the floor from the url (embedded in Facilio: ${isConnectedApp})`);
  if (isConnectedApp) {
    const hostQuery = await getHostUrlProps();
    const fromHost = clean(hostQuery?.[URL_FLOOR_KEY]);
    if (fromHost) {
      urlLog(`host url has ${URL_FLOOR_KEY}=${fromHost}`);
      return fromHost;
    }
    urlLog(`host url has no ${URL_FLOOR_KEY}`, hostQuery);
  }
  if (typeof window === 'undefined') return null;
  const own = clean(new URLSearchParams(window.location.search).get(URL_FLOOR_KEY));
  urlLog(own ? `app's own url has ${URL_FLOOR_KEY}=${own}` : `no ${URL_FLOOR_KEY} in the app's own url either`);
  return own;
}

/** The floor last written, so re-selecting the same floor (a refresh, say) writes nothing. */
let lastWritten: string | null = null;

export function writeUrlFloorId(floorId: string): void {
  if (!floorId || floorId === lastWritten) return;
  lastWritten = floorId;
  if (isConnectedApp) {
    urlLog(`floor changed to ${floorId} — pushing it to the host url`);
    pushHostUrlProps({ [URL_FLOOR_KEY]: floorId });
    return;
  }
  urlLog(`floor changed to ${floorId} — writing it to the app's own url`);
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get(URL_FLOOR_KEY) === floorId) return;
  url.searchParams.set(URL_FLOOR_KEY, floorId);
  // Replace, not push: changing floor is not a navigation, and Back should leave the app's
  // history as it was rather than step through every floor visited.
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

/**
 * Which floors to try opening on, in order: the one named in the URL (a shared link, or a reload),
 * then the user's own desk's floor. Duplicates and blanks dropped. The caller tries each in turn
 * and falls back to the portfolio's first floor when none can be placed — so a stale or foreign
 * floorId in a link degrades to the desk, never to a broken screen.
 */
export function bootFloorCandidates(urlFloorId: string | null | undefined, myDeskFloorId: string | null | undefined): { floorId: string; source: 'url' | 'desk' }[] {
  const out: { floorId: string; source: 'url' | 'desk' }[] = [];
  const url = clean(urlFloorId);
  const desk = clean(myDeskFloorId);
  if (url) out.push({ floorId: url, source: 'url' });
  if (desk && desk !== url) out.push({ floorId: desk, source: 'desk' });
  return out;
}

function clean(v: unknown): string | null {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  return s ? s : null;
}

/** Test seam: forget what was last written. */
export function _resetUrlFloorForTests(): void {
  lastWritten = null;
}
