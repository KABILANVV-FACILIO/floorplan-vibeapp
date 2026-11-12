import { RESPONDERS_FN, isVibeApp, vibe } from './vibe';
import { responderDataFrom } from './firstResponders';
import { SURFACES } from './types';
import type { Access, FirstResponder, ResponderRoleDef, Surface } from './types';

/**
 * The org-wide settings a browser must not be able to write: who the first responders are, and the
 * Roles & access grid. Both live in the app's own database behind the `floorplanResponders`
 * function, which checks with Facilio who is calling before any write and records them itself
 * (see functions/floorplanResponders/code.ts). The file-store settings blob is no place for them:
 * any signed-in user's browser can upload over it.
 *
 * Responders: Facilio's employee record has no field saying "this person is a first aider", and the
 * org's configuration is not the app's to change — so the app keeps that link, shaped like the
 * multi-lookup it stands in for: one row per role, one row per (employee, role).
 *
 * ONE SOURCE PER SESSION, never two. Running as a vibe app with the database answering, the
 * database is the source: Settings writes straight to it, and the settings blob neither carries nor
 * overrides what it holds (settingsFromState, APPLY_SETTINGS). Otherwise — `npm run dev`, or a
 * database that could not be read — they ride in the settings blob as before.
 *
 * The access grid has one more step, because orgs configured it in the blob before it moved here:
 * until an admin saves it once, the database holds no grid and the blob's still shows; the first
 * save writes the database, and from then on the database wins (state.accessStoredInDb).
 */

export interface SharedSettings {
  roles: ResponderRoleDef[];
  responders: FirstResponder[];
  /** The stored grid — {} when the database holds none yet. */
  access: Access;
}

const SURFACE_IDS = new Set<string>(SURFACES.map((s) => s.id));

/** The stored grid, made safe to use: known surfaces only, each a clean { all, roles }. */
export function accessFrom(raw: unknown): Access {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Access = {};
  for (const [surface, rule] of Object.entries(raw as Record<string, unknown>)) {
    if (!SURFACE_IDS.has(surface) || !rule || typeof rule !== 'object') continue;
    const r = rule as { all?: unknown; roles?: unknown };
    const roles = Array.isArray(r.roles) ? r.roles.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : [];
    out[surface as Surface] = { all: r.all === true, roles: r.all === true ? [] : roles };
  }
  return out;
}

/** The database's answer, or null when there is none to have — the caller keeps the settings copy. */
export async function loadSharedSettings(): Promise<SharedSettings | null> {
  if (!isVibeApp) return null;
  try {
    const raw = await vibe.executeFunction<Record<string, unknown>>(RESPONDERS_FN, 'get-settings', {});
    const data = responderDataFrom(raw);
    if (!data) {
      // eslint-disable-next-line no-console
      console.warn('[shared-settings] the app database answered with something that is not a settings read; keeping the settings copy');
      return null;
    }
    const access = accessFrom(raw?.access);
    // eslint-disable-next-line no-console
    console.info(
      `[shared-settings] from the app database: ${data.responders.length} responders in ${data.roles.length} roles, access grid ${Object.keys(access).length ? 'stored' : 'not stored yet'}`
    );
    return { ...data, access };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[shared-settings] could not read the app database; keeping the settings copy:', (err as Error)?.message ?? err);
    return null;
  }
}

/** Replace every role, in order. Throws when the write is refused, so the caller can say so. */
export async function saveResponderRoles(roles: ResponderRoleDef[]): Promise<void> {
  const rows = roles.map(({ id, name, plural, color, icon, text, shape }) => ({ id, name, plural, color, icon, text, shape }));
  await vibe.executeFunction(RESPONDERS_FN, 'save-roles', { rolesJson: JSON.stringify(rows) });
}

/** Replace every responder — the links and their names, in one write. Throws when refused. */
export async function saveResponders(responders: FirstResponder[]): Promise<void> {
  await vibe.executeFunction(RESPONDERS_FN, 'save-responders', { respondersJson: JSON.stringify(responders) });
}

/** Replace the Roles & access grid. Throws when refused — for one, a caller who may not change it. */
export async function saveAccess(access: Access): Promise<void> {
  await vibe.executeFunction(RESPONDERS_FN, 'save-access', { accessJson: JSON.stringify(accessFrom(access)) });
}

/**
 * What to tell the user about a refused write. The function's own words when it refused on
 * purpose ("Not saved: only admins and roles given Settings can change this"), else nothing — a
 * transport error's text is no use to them.
 */
export function refusalReason(err: unknown): string | null {
  const text = String((err as Error)?.message ?? err ?? '');
  const m = /Not saved:[^"\\]*/.exec(text);
  return m ? m[0].replace(/^Not saved:\s*/, '').trim() : null;
}
