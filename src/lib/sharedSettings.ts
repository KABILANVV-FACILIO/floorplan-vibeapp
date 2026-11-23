import { RESPONDERS_FN, isVibeApp, vibe } from './vibe';
import { responderDataFrom } from './firstResponders';
import { sanitizeSettings, splitSettings } from './settingsStore';
import { sanitizeDepartmentColors } from './departmentColorStore';
import { SURFACES } from './types';
import type { Access, FirstResponder, ResponderRoleDef, Surface } from './types';
import type { SettingsConfig } from './settingsStore';
import type { DepartmentColorScheme } from './departmentColorStore';

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
 *
 * The rest of the settings blob, the print settings and the department colours followed the same
 * way (fp_app_setting: a row each for 'settings', 'print', 'departmentColors'). Each part's source
 * is the database once it holds that part's row, else the file store's copy (state.settingsDb). The
 * function lets admins and roles given Settings write the settings and the colours, and anyone who
 * prints write the print settings — which the print window keeps for everyone.
 */

export interface SharedSettings {
  roles: ResponderRoleDef[];
  responders: FirstResponder[];
  /** The stored grid — {} when the database holds none yet. */
  access: Access;
  /**
   * False when the function could not read the settings' table (fp_app_setting, not imported yet)
   * or is a version from before it: the settings, print settings and colours then stay with the
   * file store this session — read and saved there as before — and the three below are null.
   */
  appSettingsRead: boolean;
  /**
   * Why the settings' table was not read: 'unavailable' — not imported yet, so the settings stay
   * with the file store as above — or 'too-large', the table there but its row too large for the
   * function's answer. That one is NOT "keep them in the file store": saved there, changes would be
   * lost on the next load, so they are held for the session (FloorplanContext). Null when read.
   * (Any other failure of the table fails the whole read — see loadSharedSettings.)
   */
  appSettingsError: 'too-large' | 'unavailable' | null;
  /** The settings blob but for its print keys, made safe to apply — null when the database holds none. */
  appSettings: SettingsConfig | null;
  /** The print window's keys alone — null when the database holds none. */
  printSettings: SettingsConfig | null;
  /** The department colour scheme — null when the database holds none. */
  departmentColors: DepartmentColorScheme | null;
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

/**
 * The database's answer, or null when there is none to have (not a vibe app, or a function from
 * before the settings read) — the caller then keeps the settings copy.
 *
 * REJECTS when the database is there but could not be asked. That is not "no database": saved to
 * the file store meanwhile, every change would be lost on the next load, which reads the
 * database's rows over the file. The caller holds the saves and asks again (FloorplanContext).
 */
export async function loadSharedSettings(): Promise<SharedSettings | null> {
  if (!isVibeApp) return null;
  let raw: Record<string, unknown>;
  try {
    raw = await vibe.executeFunction<Record<string, unknown>>(RESPONDERS_FN, 'get-settings', {});
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[shared-settings] could not read the app database:', (err as Error)?.message ?? err);
    throw err;
  }
  const data = responderDataFrom(raw);
  if (!data) {
    // eslint-disable-next-line no-console
    console.warn('[shared-settings] the app database answered with something that is not a settings read; keeping the settings copy');
    return null;
  }
  const access = accessFrom(raw?.access);
  // Each made safe as the file store's copy is (the function checks what it stores, but the app
  // applies only what it would have written itself), and each held to its own keys.
  const appSettings = raw?.appSettings == null ? null : sanitizeSettings(raw.appSettings);
  const printSettings = raw?.printSettings == null ? null : sanitizeSettings(raw.printSettings);
  const departmentColors = raw?.departmentColors == null ? null : sanitizeDepartmentColors(raw.departmentColors);
  const stored = (name: string, part: unknown) => `${name} ${part ? 'stored' : 'not stored yet'}`;
  // eslint-disable-next-line no-console
  console.info(
    `[shared-settings] from the app database: ${data.responders.length} responders in ${data.roles.length} roles, ${[
      stored('access grid', Object.keys(access).length),
      ...(raw?.appSettingsRead === true
        ? []
        : [raw?.appSettingsError === 'too-large' ? 'settings row too large to read — settings changes are held this session' : 'settings table not imported — the settings stay in the file store']),
      stored('settings', appSettings),
      stored('print settings', printSettings),
      stored('department colours', departmentColors),
    ].join(', ')}`
  );
  return {
    ...data,
    access,
    appSettingsRead: raw?.appSettingsRead === true,
    appSettingsError: raw?.appSettingsError === 'too-large' || raw?.appSettingsError === 'unavailable' ? raw.appSettingsError : null,
    appSettings: appSettings && splitSettings(appSettings).settings,
    printSettings: printSettings && splitSettings(printSettings).print,
    departmentColors,
  };
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

/** Replace the settings but for the print keys, which the function leaves out. Throws when refused. */
export async function saveAppSettings(cfg: SettingsConfig): Promise<void> {
  await vibe.executeFunction(RESPONDERS_FN, 'save-app-settings', { settingsJson: JSON.stringify(splitSettings(cfg).settings) });
}

/**
 * Replace the print window's settings — any caller Facilio can name may. The two keys this app
 * writes, never v68–v71's `parkingPrint` (read, not written), which the function refuses.
 * Throws when refused.
 */
export async function savePrintSettings(cfg: SettingsConfig): Promise<void> {
  const { printScope, printRegisters } = cfg;
  await vibe.executeFunction(RESPONDERS_FN, 'save-print-settings', { printJson: JSON.stringify({ printScope, printRegisters }) });
}

/** Replace the department colour scheme — every department's colour, in one write. Throws when refused. */
export async function saveDepartmentColorScheme(scheme: DepartmentColorScheme): Promise<void> {
  await vibe.executeFunction(RESPONDERS_FN, 'save-department-colors', { colorsJson: JSON.stringify(scheme) });
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

/** The toast for a write the function did not take: its reason when it refused on purpose. */
export function notSavedNotice(what: string, err: unknown): string {
  const reason = refusalReason(err);
  return reason ? `Couldn't save the ${what} — ${reason}.` : `Couldn't save the ${what}. Try again.`;
}
