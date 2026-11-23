import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

/**
 * floorplanResponders — the app's org-wide settings that must not be writable from a browser: who
 * the first responders are, who may reach each tab (the Roles & access grid), and the rest of the
 * app's settings, its print settings and its department colours. The name is from when it held the
 * responders alone.
 *
 * Facilio's employee record has no field for it, and the org's configuration is not ours to
 * change, so the app keeps the link itself. The shape is a multi-lookup's, kept by hand:
 *
 *   fp_responder_role            one row per role (first aider, floor warden, the org's own),
 *                                with the badge it draws — symbol, shape, colour.
 *   fp_employee_responder_role   one row per (employee, role): the multi-lookup itself. An
 *                                employee id is the org's people id, so the person stays the
 *                                org's record; only the link lives here.
 *   fp_responder_detail          one row per responder, holding only `employee_name`: a copy of
 *                                the record's name for the moment before the app's directory
 *                                has loaded. Everything else about the person — department,
 *                                mobile, the name itself — the app reads off the employee record.
 *                                (The table's group_name / ext / mobile columns are from a first
 *                                draft that typed those in; they are left empty. A table cannot
 *                                be dropped from here, and nothing reads them.)
 *   fp_access                    one row per surface (a tab, or a right on the plan): `all_roles` 1 for every role,
 *                                else the role ids in `roles` (a JSON list). No row = the app's
 *                                default for that surface.
 *   fp_app_setting               one row per group of the app's other settings, the group's whole
 *                                JSON object in `value_json`: 'settings' (the app's settings blob
 *                                but for the print window's keys — module colours, colour-by,
 *                                label style, enabled modules, plan labels, custom markers, slot
 *                                granularity, the booking module; the access grid only while
 *                                fp_access holds none),
 *                                'print' (the print window's: printScope, printRegisters) and
 *                                'departmentColors' (department id -> { name, color }). No row = the
 *                                app keeps the copy in its file store, where these lived before.
 *
 * WHO MAY WRITE is decided here, never by the browser. Every write asks Facilio who the caller is
 * (the run carries the caller's own identity, and the facilio-cmms connection answers as them),
 * then allows an admin role (privileged in the org's role list), or a role the stored grid gives
 * Settings. The grid is fp_access's; while fp_access holds none at all, it is the one the 'settings'
 * row of fp_app_setting still carries (`access`), as the app itself shows it until an admin saves
 * the grid once. With no Settings rule in either, that is admins only. If Facilio cannot say who is
 * calling, the write is refused; if it names the caller but cannot list the roles (busy, or down),
 * a caller the grid does not name is refused as "could not confirm your role", not as a non-admin.
 * `updated_by` is the name Facilio gives, whatever the browser sends. The one exception is the
 * print settings: the print window offers them to everyone who prints ("for everyone who prints
 * them"), so save-print-settings takes any caller Facilio can name — one profile call, no role
 * list — and holds them to the print keys and the values the window offers.
 *
 * NO DDL HERE, by necessity: the app's database login holds DML only (USAGE + SELECT / INSERT /
 * UPDATE / DELETE — vibe-server provisions it with WRITE, and WRITE grants no CREATE), so even
 * `create table if not exists` is refused. The tables were made with `facilio vibe db import` from
 * the CSVs in ./tables. An import makes a column numeric when every value in it looks numeric, else
 * text — so the id and text columns were seeded with a `__seed__` row to keep them text (reads skip
 * it and the first save removes it), and the two meant as numbers are numeric:
 * fp_responder_role.sort_order and fp_access.all_roles. Everything else is text.
 *
 * NO TRANSACTIONS either (one connection per query), so each table's replace is ONE statement:
 * a data-modifying CTE deletes the old set and inserts the new one, which Postgres runs
 * atomically, and a failed save leaves the previous set whole rather than half of each. A save is
 * not always one statement in all: save-roles replaces the roles in one, then drops the links and
 * details that named a removed role in two more. And two saves at the same moment are not
 * serialised — under READ COMMITTED their delete-then-insert statements can interleave and leave
 * both lists merged; the next save puts it right.
 *
 * Every save is checked BEFORE Facilio is asked who is calling, so an oversized or malformed request
 * costs no identity calls and runs no statement: its size always, and every field for the roles,
 * responders, grid, print settings and colours. save-app-settings is checked for its size and for
 * being a JSON object only — its keys are stored as sent (but for the print keys, which it drops),
 * and the app makes the blob safe when it reads it (settingsStore sanitizeSettings).
 *
 * Handler parameters may only be string or number, so lists travel as JSON strings.
 */

const server = new StudioFunctions({ name: 'floorplanResponders' });

const SEED = '__seed__';
const ICONS = ['cross', 'warden', 'flame', 'aed', 'shield', 'megaphone', 'radiation', 'drop', 'star', 'phone', 'bell', 'text'];
const SHAPES = ['square', 'circle', 'diamond'];
const HEX = /^#[0-9a-fA-F]{6}$/;

// The four tabs and the rights within them: the plan's three, and booking from the calendar (the
// app's lib/types SURFACES).
const SURFACE_IDS = ['map', 'map.assign', 'map.book', 'map.edit', 'bookings', 'bookings.book', 'people', 'settings'];

/**
 * The two roles every org has, which the app never lets go (lib/firstResponders sanitizeRoles puts
 * them in front of every list it saves): a printed notice always has its first aiders and wardens.
 */
const REQUIRED_ROLES = ['firstAider', 'floorWarden'];

/**
 * How much one save may carry. Far above what the screen sends — an org has two built-in roles and
 * a few of its own, a responder list in the hundreds, a grid of eight surfaces over its roles
 * (ENEC has 14) — and low enough that a request built to be huge is refused before it runs.
 */
const MAX_JSON_CHARS = 500_000;
const MAX_ROLES = 50;
const MAX_RESPONDERS = 2000;
const MAX_ROLES_PER_SURFACE = 500;
/** An employee id is the org's people record id: digits only. */
const EMPLOYEE_ID = /^\d{1,19}$/;

/** fp_app_setting's rows, by `setting_key`. */
const SETTINGS_ROW = 'settings';
const PRINT_ROW = 'print';
const COLORS_ROW = 'departmentColors';
/**
 * The print window's keys in the app's settings blob, kept in their own row. `parkingPrint` is
 * where v68–v71 kept the parking register: the app still reads it and never writes it, so a save
 * may not either.
 */
const PRINT_KEYS = ['printScope', 'printRegisters'];
const LEGACY_PRINT_KEYS = ['parkingPrint'];
/** What the print window offers (the app's AppState printScope and lib/types RegisterPrint). */
const PRINT_SCOPES = ['detail', 'view', 'floor'];
const REGISTER_KINDS = ['workstation', 'parking', 'locker', 'room'];
const REGISTER_ROWS = ['all', 'assigned', 'vacant'];
const REGISTER_SORTS = ['name', 'status', 'dept', 'emp'];
/** A register column is one of lib/register's keys — short, plain identifiers. */
const COLUMN_KEY = /^[A-Za-z0-9_]{1,60}$/;
const MAX_REGISTER_COLS = 60;
/**
 * The settings row carries the org's custom markers, and a marker's image may be an inline
 * data:image of up to 200,000 characters (the app's settingsStore cleanMarker) — so a library of a
 * few drawn icons is already past the 500,000 the other saves allow. 2,000,000 holds ten markers at
 * that limit with the rest of the settings beside them (a few thousand characters). The runtime's
 * own limits — on a request's size, and on how much one read may answer before it is capped — are
 * not known from here, so this is not lowered to one; a settings row the database then answers
 * only in part is reported as such by get-settings (`appSettingsError: 'too-large'`), and the
 * responders and the grid still load beside it.
 */
const MAX_SETTINGS_CHARS = 2_000_000;
/** Four registers of at most 60 columns each, with room to spare; anyone who prints may send it. */
const MAX_PRINT_CHARS = 50_000;
/** More departments than an org has; each entry is a short name and a colour. */
const MAX_DEPARTMENTS = 1000;
const MAX_DEPARTMENT_TEXT = 200;

/** One connection action, run as the caller. Throws on anything but a clean answer. */
async function action(connection: string, slug: string, input: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${process.system.CONNECTIONS_URL}/api/v1/connections/${connection}/actions/${slug}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`${connection}.${slug} answered ${res.status}`);
  return res.json();
}

interface Profile {
  roleId: string;
  name: string;
  /** The Facilio app the caller is in, whose roles list-roles is asked for. */
  app: string;
}

interface Caller extends Profile {
  isAdmin: boolean;
  /**
   * False when list-roles did not answer with a list (refused as busy, or failed): whether the
   * caller is an admin is then unknown, not "no" — a refusal says so (settingsWriter).
   */
  rolesKnown: boolean;
}

/**
 * Who is calling, as Facilio says — never as the browser says. One connection call: enough for a
 * save open to anyone Facilio can name (save-print-settings), and the first half of whoIsCalling.
 */
async function profileOf(): Promise<Profile> {
  let profile: any;
  try {
    profile = await action('facilio-cmms', 'get-current-user-profile', {});
  } catch (err) {
    throw new Error(`Not saved: could not confirm who is signed in (${(err as Error)?.message ?? err})`);
  }
  const user = profile?.data?.user;
  const roleId = user?.role?.id;
  if (!user || roleId == null) throw new Error('Not saved: Facilio did not say who is signed in');
  return { roleId: String(roleId), name: String(user.name || user.email || `user #${user.id}`), app: profile?.data?.app?.linkName || 'maintenance' };
}

/**
 * Whether a role record is one of the org's admin roles. Facilio flags these on the record, and
 * spells the flag two ways across its payloads: the connector says `isPrivileged`, the backend's
 * Role class `isPrevileged`; `isSuperAdmin` may also arrive as `superAdmin` (the app's own
 * isAdminRole reads the same four).
 */
function isAdminRole(role: any): boolean {
  return !!(role && (role.isPrivileged || role.isPrevileged || role.isSuperAdmin || role.superAdmin));
}

/** list-roles' answer as the list it carries — null when it carries none. */
function roleList(body: any): any[] | null {
  return Array.isArray(body?.data) ? body.data : null;
}

/** Who is calling, and whether their role is an admin one: the profile, then the org's roles. */
async function whoIsCalling(): Promise<Caller> {
  const profile = await profileOf();
  const roles = roleList(await action('facilio-user-management', 'list-roles', { app: profile.app }).catch(() => null));
  const role = (roles ?? []).find((r: any) => String(r?.id) === profile.roleId);
  return { ...profile, isAdmin: isAdminRole(role), rolesKnown: roles !== null };
}

/**
 * A read's rows — refused when the database capped the answer (`truncated`): a list read in part
 * would be taken for the whole one (an access rule missing, a responder dropped), and a save built
 * on it would make that loss permanent. fp_app_setting's read is the one exception: it says so in
 * its answer instead (readAppSettings).
 */
function rowsOf(db: any, sql: string, params: unknown[] = []): any[] {
  return wholeRows(db.query(sql, params));
}

function wholeRows(res: any): any[] {
  if (res?.truncated) throw new Error('the app database answered only in part — not read');
  return res?.rows ?? [];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

interface AppSettingsOut {
  /** False when fp_app_setting could not be read whole — `appSettingsError` says why; the three below are then null. */
  appSettingsRead: boolean;
  /**
   * Only when `appSettingsRead` is false. 'unavailable': the table is not there (not imported
   * yet). 'too-large': the database answered only in part — a row past what one read may answer
   * (a settings blob heavy with drawn marker images).
   */
  appSettingsError?: 'too-large' | 'unavailable';
  appSettings: Record<string, unknown> | null;
  printSettings: Record<string, unknown> | null;
  departmentColors: Record<string, unknown> | null;
}

/** Postgres' "no such table" (SQLSTATE 42P01), as the app database reports it, for fp_app_setting alone. */
function isMissingAppSettingTable(err: unknown): boolean {
  if ((err as { code?: unknown })?.code === '42P01') return true;
  return /relation "(?:[^"]*\.)?fp_app_setting" does not exist/.test(String((err as Error)?.message ?? err));
}

/**
 * fp_app_setting's rows, each parsed — null for a group the table holds no row for, and for a row
 * that is not a JSON object. A table not there yet, or a row too large to read, never fails the
 * read of the rest — the responders and the grid load beside it — but neither is ever guessed at:
 *  - until the table is imported the select fails, and the answer says so (`appSettingsRead`
 *    false, 'unavailable'): the app then keeps its file store for all three, reads and saves
 *    alike, rather than send saves to a table that is not there;
 *  - a capped answer is not served as the whole (`appSettingsRead` false, 'too-large'), so a part
 *    left out is never read as "none stored";
 *  - any other failure (a timeout, a dropped connection) fails get-settings, as a failed read of
 *    any other table does: taken for "not imported", it would send this session's saves to the
 *    file store while the table holds the org's settings.
 * Oldest first, so if two saves at once left two rows for a group, the newer one is the one kept.
 */
function readAppSettings(db: any): AppSettingsOut {
  const out: AppSettingsOut = { appSettingsRead: false, appSettings: null, printSettings: null, departmentColors: null };
  let res: any;
  try {
    res = db.query(`select setting_key, value_json from fp_app_setting where setting_key in ($1, $2, $3) order by updated_at`, [SETTINGS_ROW, PRINT_ROW, COLORS_ROW]);
  } catch (err) {
    if (isMissingAppSettingTable(err)) return { ...out, appSettingsError: 'unavailable' };
    throw err;
  }
  const take = (rows: any[]) => {
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(String(r.value_json ?? ''));
      } catch {
        continue;
      }
      if (!isObject(value)) continue;
      if (r.setting_key === SETTINGS_ROW) out.appSettings = value;
      else if (r.setting_key === PRINT_ROW) out.printSettings = value;
      else if (r.setting_key === COLORS_ROW) out.departmentColors = value;
    }
  };
  if (res?.truncated) {
    // The settings row is the one that grows (drawn marker images): the print settings and the
    // colours, small rows of their own, are read apart from it, so they still load while it cannot.
    let small: any = null;
    try {
      small = db.query(`select setting_key, value_json from fp_app_setting where setting_key in ($1, $2) order by updated_at`, [PRINT_ROW, COLORS_ROW]);
    } catch {
      small = null;
    }
    if (small && !small.truncated) take(small.rows ?? []);
    return { ...out, appSettingsError: 'too-large' };
  }
  out.appSettingsRead = true;
  take(res?.rows ?? []);
  return out;
}

/**
 * Replace one group's row, in ONE statement (see the header: no transactions): the old row — and
 * the import's seed row, the first time — out, the new one in.
 */
function writeAppSetting(db: any, key: string, value: Record<string, unknown>, by: string): void {
  db.query(
    `with gone as (delete from fp_app_setting where setting_key in ($1, $5))
     insert into fp_app_setting (setting_key, value_json, updated_at, updated_by)
     values ($1, $2, $3, $4)`,
    [key, JSON.stringify(value), new Date().toISOString(), by, SEED]
  );
}

/**
 * The print window's settings, held to what the window offers: printScope one of its three
 * choices, printRegisters a register per known kind with its four fields. Anything else — another
 * key, another kind, a field or value the window never sends — is refused, not dropped: this save
 * is open to every caller, so it stores nothing the app would not have written itself.
 */
function cleanPrint(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (key === 'printScope') {
      if (typeof v !== 'string' || PRINT_SCOPES.indexOf(v) === -1) throw new Error(`printScope must be one of ${PRINT_SCOPES.join(', ')}`);
      out.printScope = v;
    } else if (key === 'printRegisters') {
      if (!isObject(v)) throw new Error('printRegisters must be a JSON object');
      out.printRegisters = Object.fromEntries(
        Object.entries(v).map(([kind, r]) => {
          if (REGISTER_KINDS.indexOf(kind) === -1) throw new Error(`printRegisters: unknown register ${kind}`);
          return [kind, cleanRegister(kind, r)];
        })
      );
    } else {
      throw new Error(`printJson: ${key} is not a print setting`);
    }
  }
  return out;
}

function cleanRegister(kind: string, raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) throw new Error(`${kind} register: expected { register, cols, rows, sort }`);
  const out: Record<string, unknown> = {};
  for (const [field, v] of Object.entries(raw)) {
    if (field === 'register') {
      if (typeof v !== 'boolean') throw new Error(`${kind} register: register must be true or false`);
      out.register = v;
    } else if (field === 'cols') {
      if (!Array.isArray(v)) throw new Error(`${kind} register: cols must be a list`);
      if (v.length > MAX_REGISTER_COLS) throw new Error(`${kind} register: ${v.length} columns — at most ${MAX_REGISTER_COLS}`);
      for (const c of v) if (typeof c !== 'string' || !COLUMN_KEY.test(c)) throw new Error(`${kind} register: unknown column ${String(c).slice(0, 60)}`);
      out.cols = v;
    } else if (field === 'rows') {
      if (typeof v !== 'string' || REGISTER_ROWS.indexOf(v) === -1) throw new Error(`${kind} register: rows must be one of ${REGISTER_ROWS.join(', ')}`);
      out.rows = v;
    } else if (field === 'sort') {
      if (typeof v !== 'string' || REGISTER_SORTS.indexOf(v) === -1) throw new Error(`${kind} register: sort must be one of ${REGISTER_SORTS.join(', ')}`);
      out.sort = v;
    } else {
      throw new Error(`${kind} register: unknown field ${field}`);
    }
  }
  return out;
}

function readAccess(db: any): Record<string, { all: boolean; roles: string[] }> {
  const rows = rowsOf(db, `select surface, all_roles, roles from fp_access where surface is not null and surface <> $1`, [SEED]);
  const out: Record<string, { all: boolean; roles: string[] }> = {};
  for (const r of rows) {
    if (SURFACE_IDS.indexOf(String(r.surface)) === -1) continue;
    let roles: string[] = [];
    try {
      const v = JSON.parse(String(r.roles ?? '[]'));
      if (Array.isArray(v)) roles = v.map(String);
    } catch {
      roles = [];
    }
    out[String(r.surface)] = { all: Number(r.all_roles) === 1, roles };
  }
  return out;
}

/**
 * Who the stored grid gives Settings. fp_access's rule, when fp_access holds a grid; while it holds
 * none at all, the rule the 'settings' row of fp_app_setting carries — the grid as orgs set it
 * before it moved to fp_access, which the app applies until an admin saves the grid once (its
 * reducer's ACCESS_LOADED: a grid in the database replaces the blob's, none leaves the blob's). Only
 * what that row holds as the app writes it ({ all, roles }); no rule there is none, as before.
 */
function settingsRule(db: any): { all: boolean; roles: string[] } | undefined {
  const grid = readAccess(db);
  if (Object.keys(grid).length > 0) return grid.settings;
  const access = readAppSettings(db).appSettings?.access;
  const rule = isObject(access) ? access.settings : undefined;
  if (!isObject(rule)) return undefined;
  return { all: rule.all === true, roles: Array.isArray(rule.roles) ? rule.roles.map(String) : [] };
}

/** The caller, when they may change the app's settings; otherwise the write is refused. */
async function settingsWriter(db: any): Promise<Caller> {
  const caller = await whoIsCalling();
  if (caller.isAdmin) return caller;
  const rule = settingsRule(db);
  if (rule && (rule.all || rule.roles.indexOf(caller.roleId) !== -1)) return caller;
  // Not named by the grid, and Facilio did not list the roles: an admin cannot be told from anyone
  // else, so this is no answer about their role — and they are told to try again, not that they
  // may not.
  if (!caller.rolesKnown) throw new Error('Not saved: could not confirm your role, Facilio is busy. Try again in a minute');
  throw new Error('Not saved: only admins and roles given Settings can change this');
}

function connect() {
  // vibe-server puts the app's database login into every run's env (FunctionRunUtil.buildEnv).
  return new StudioDatabase({ userName: process.env.DB_USER, password: process.env.DB_PASSWORD, schema: process.env.SCHEMA });
}

/** A JSON parameter, parsed — refused when missing, too long or not JSON, before anything else. */
function parseJson(raw: unknown, what: string, max = MAX_JSON_CHARS): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`${what} is required`);
  if (raw.length > max) throw new Error(`${what} is too large (${raw.length} characters, at most ${max})`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

function parseObject(raw: unknown, what: string, max = MAX_JSON_CHARS): Record<string, unknown> {
  const v = parseJson(raw, what, max);
  if (!isObject(v)) throw new Error(`${what} must be a JSON object`);
  return v;
}

function parseList(raw: unknown, what: string, max: number): Record<string, unknown>[] {
  const v = parseJson(raw, what);
  if (!Array.isArray(v)) throw new Error(`${what} must be a JSON array`);
  if (v.length > max) throw new Error(`${what} has ${v.length} entries — at most ${max}`);
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

/** Trimmed text, or null for blank — never the seed marker, which reads would then hide. */
function str(v: unknown, max = 200): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim().slice(0, max);
  return s === '' || s === SEED ? null : s;
}

interface RoleOut {
  id: string;
  name: string;
  plural: string;
  color: string;
  icon: string;
  shape: string;
  text?: string;
}

function readRoles(db: any): RoleOut[] {
  const rows = rowsOf(
    db,
    `select id, name, plural, color, icon, shape, badge_text from fp_responder_role
      where id is not null and id <> $1
      order by sort_order nulls last, name`,
    [SEED]
  );
  return rows.map((r: any) => {
    const out: RoleOut = { id: String(r.id), name: String(r.name ?? ''), plural: String(r.plural ?? ''), color: String(r.color ?? ''), icon: String(r.icon ?? ''), shape: String(r.shape ?? '') };
    if (r.badge_text) out.text = String(r.badge_text);
    return out;
  });
}

function readResponders(db: any): { roles: RoleOut[]; responders: { employeeId: string; name: string; roles: string[] }[] } {
  const roles = readRoles(db);
  const order = roles.map((r) => r.id);

  const members = rowsOf(db, `select employee_id, role_id from fp_employee_responder_role where employee_id <> $1`, [SEED]);
  const details = rowsOf(db, `select employee_id, employee_name from fp_responder_detail where employee_id <> $1`, [SEED]);

  const rolesOf = new Map<string, string[]>();
  for (const m of members) {
    const id = String(m.employee_id ?? '');
    const role = String(m.role_id ?? '');
    if (!id || order.indexOf(role) === -1) continue; // a role since removed
    // Not an org people id (a `c1` from a dev session): left out, so the app never sends it back
    // to save-responders, which refuses the whole list for it. The next save clears the row.
    if (!EMPLOYEE_ID.test(id)) continue;
    const list = rolesOf.get(id) ?? [];
    if (list.indexOf(role) === -1) list.push(role);
    rolesOf.set(id, list);
  }
  const nameOf = new Map<string, string>(details.map((d: any) => [String(d.employee_id), String(d.employee_name ?? '')]));

  const responders = [...rolesOf.entries()].map(([employeeId, held]) => ({
    employeeId,
    name: nameOf.get(employeeId) ?? '',
    roles: order.filter((id) => held.indexOf(id) !== -1),
  }));
  return { roles, responders };
}

server.addHandler({
  name: 'get-settings',
  description:
    "Everything the app reads from here, in one call: { roles, responders, access, appSettingsRead, appSettingsError?, appSettings, printSettings, departmentColors } — responders whose employee id is not an org record id (digits) are left out; access is { surface: { all, roles } } for the surfaces stored, {} when none are; the last three are the stored JSON objects, each null when none is stored. appSettingsRead is false when their table could not be read whole, and appSettingsError then says why: 'unavailable' (the table is not there) or 'too-large' (the database answered only in part).",
  parameters: {},
  execute: async () => {
    const db = connect();
    return { ...readResponders(db), access: readAccess(db), ...readAppSettings(db) };
  },
});

server.addHandler({
  name: 'list-roles',
  description:
    "The org's roles, from facilio-user-management.list-roles, as { data: [{ id, name, isPrivileged }] } — isPrivileged true for an admin role under any of the flags Facilio uses — for the Roles & access grid. Run here, not from the browser, where connection calls are deprecated.",
  parameters: {},
  execute: async () => {
    // Only what the grid reads (the app's rolesFrom: an id, a name, the admin flag) — not the
    // record's every field, user counts and all, to every browser that opens Settings. The flags
    // folded into the one spelling the app reads strictly (`isPrivileged === true`).
    const roles = roleList(await action('facilio-user-management', 'list-roles', {})) ?? [];
    return { data: roles.map((r: any) => ({ id: r?.roleId ?? r?.id, name: r?.label ?? r?.name, isPrivileged: isAdminRole(r) })) };
  },
});

// Kept for a deployed build that still asks for it.
server.addHandler({
  name: 'get-responders',
  description: 'The org\'s responder roles in order, and every responder with their roles: { roles, responders }.',
  parameters: {},
  execute: async () => readResponders(connect()),
});

server.addHandler({
  name: 'save-roles',
  description: 'Replace every responder role with the supplied list, in order. A role left out also drops off everyone who held it.',
  parameters: {
    rolesJson: { description: 'JSON array of {id,name,plural,color,icon,shape,text?}, in display order — first aider and floor warden always among them', type: 'string' },
  },
  execute: async (args) => {
    const seen: string[] = [];
    const rows = parseList(args.rolesJson, 'rolesJson', MAX_ROLES).map((r, i) => {
      const id = str(r.id, 80);
      const name = str(r.name, 80);
      if (!id || !name) throw new Error(`role ${i + 1}: id and name are required`);
      if (seen.indexOf(id) !== -1) throw new Error(`role ${id} is listed twice`);
      seen.push(id);
      const icon = str(r.icon, 20) ?? 'text';
      const shape = str(r.shape, 20) ?? 'circle';
      const color = str(r.color, 7) ?? '';
      if (ICONS.indexOf(icon) === -1) throw new Error(`role ${id}: unknown symbol ${icon}`);
      if (SHAPES.indexOf(shape) === -1) throw new Error(`role ${id}: unknown shape ${shape}`);
      if (!HEX.test(color)) throw new Error(`role ${id}: colour must be #RRGGBB`);
      return { id, name, plural: str(r.plural, 80) ?? `${name}s`, color: color.toUpperCase(), icon, shape, badge_text: icon === 'text' ? str(r.text, 2) : null, sort_order: i + 1 };
    });
    // An empty list, or one without the two built-in roles, would delete them — and with them every
    // responder link and name in the org, in one call. The screen never sends one (it always keeps
    // both); a request that does is refused here, where the rule is enforced.
    if (rows.length === 0) throw new Error('rolesJson must list the responder roles — an empty list is refused');
    const missing = REQUIRED_ROLES.filter((id) => seen.indexOf(id) === -1);
    if (missing.length) throw new Error(`rolesJson must keep the built-in roles (missing: ${missing.join(', ')})`);

    const db = connect();
    const by = (await settingsWriter(db)).name;
    const at = new Date().toISOString();
    db.query(
      `with gone as (delete from fp_responder_role)
       insert into fp_responder_role (id, name, plural, color, icon, shape, badge_text, sort_order, updated_at, updated_by)
       select id, name, plural, color, icon, shape, badge_text, sort_order, $2, $3
         from json_to_recordset($1::json) as x(id text, name text, plural text, color text, icon text, shape text, badge_text text, sort_order numeric)`,
      [JSON.stringify(rows), at, by]
    );
    // Anyone who held a role that is gone no longer holds it; a responder left with no role is no
    // longer one, and their notice details go with them.
    db.query(`delete from fp_employee_responder_role where role_id not in (select id from fp_responder_role where id is not null)`);
    db.query(`delete from fp_responder_detail where employee_id not in (select employee_id from fp_employee_responder_role where employee_id is not null)`);
    return { ok: true, roles: rows.length };
  },
});

server.addHandler({
  name: 'save-responders',
  description: 'Replace every responder — who holds which roles — with the supplied list, in one atomic write. Roles not in fp_responder_role are dropped.',
  parameters: {
    respondersJson: { description: 'JSON array of {employeeId,name,roles:[roleId]}', type: 'string' },
  },
  execute: async (args) => {
    const byId = new Map<string, { employee_id: string; employee_name: string; roles: string[] }>();
    for (const r of parseList(args.respondersJson, 'respondersJson', MAX_RESPONDERS)) {
      const employeeId = str(r.employeeId, 40);
      if (Array.isArray(r.roles) && r.roles.length > MAX_ROLES) throw new Error(`responder ${employeeId ?? '?'} has ${r.roles.length} roles — at most ${MAX_ROLES}`);
      const roles = Array.isArray(r.roles) ? (r.roles.map((x) => str(x, 80)).filter(Boolean) as string[]) : [];
      if (!employeeId || roles.length === 0) continue;
      if (!EMPLOYEE_ID.test(employeeId)) throw new Error(`responder "${employeeId}": the employee id must be the org's record id (digits only)`);
      const prev = byId.get(employeeId);
      if (prev) {
        for (const role of roles) if (prev.roles.indexOf(role) === -1) prev.roles.push(role);
        continue;
      }
      byId.set(employeeId, { employee_id: employeeId, employee_name: str(r.name) ?? '', roles });
    }
    const people = [...byId.values()];

    const db = connect();
    const by = (await settingsWriter(db)).name;
    const at = new Date().toISOString();
    // Both tables in ONE statement, so the links and the names can never disagree after a
    // failure. Each CTE sees the same snapshot: the inserts don't see the deletes, and with no
    // unique keys they don't need to.
    db.query(
      `with input as (
         select * from json_to_recordset($1::json)
           as x(employee_id text, employee_name text, roles json)
       ),
       gone_links as (delete from fp_employee_responder_role),
       gone_details as (delete from fp_responder_detail),
       details as (
         insert into fp_responder_detail (employee_id, employee_name, updated_at, updated_by)
         select employee_id, employee_name, $2, $3 from input
       )
       insert into fp_employee_responder_role (employee_id, role_id, updated_at, updated_by)
       select i.employee_id, r.role_id, $2, $3
         from input i
         cross join lateral json_array_elements_text(i.roles) as r(role_id)
        where r.role_id in (select id from fp_responder_role where id is not null)`,
      [JSON.stringify(people), at, by]
    );
    return { ok: true, responders: people.length };
  },
});

server.addHandler({
  name: 'save-access',
  description: 'Replace the Roles & access grid: { surface: { all, roles } }. A surface left out falls back to the app default. Admins keep Settings whatever this says.',
  parameters: {
    accessJson: { description: 'JSON object of surface -> { all: boolean, roles: string[] }', type: 'string' },
  },
  execute: async (args) => {
    const grid = parseJson(args.accessJson, 'accessJson');
    if (!grid || typeof grid !== 'object' || Array.isArray(grid)) throw new Error('accessJson must be a JSON object');
    const rows = Object.entries(grid as Record<string, any>).map(([surface, rule]) => {
      if (SURFACE_IDS.indexOf(surface) === -1) throw new Error(`unknown surface: ${surface}`);
      if (!rule || typeof rule !== 'object') throw new Error(`${surface}: expected { all, roles }`);
      if (Array.isArray(rule.roles) && rule.roles.length > MAX_ROLES_PER_SURFACE) throw new Error(`${surface}: ${rule.roles.length} roles — at most ${MAX_ROLES_PER_SURFACE}`);
      const roles = Array.isArray(rule.roles) ? rule.roles.map((r: unknown) => str(r, 40)).filter(Boolean) : [];
      return { surface, all_roles: rule.all ? 1 : 0, roles: JSON.stringify(rule.all ? [] : roles) };
    });

    const db = connect();
    const by = (await settingsWriter(db)).name;
    const at = new Date().toISOString();
    db.query(
      `with gone as (delete from fp_access)
       insert into fp_access (surface, all_roles, roles, updated_at, updated_by)
       select surface, all_roles, roles, $2, $3
         from json_to_recordset($1::json) as x(surface text, all_roles numeric, roles text)`,
      [JSON.stringify(rows), at, by]
    );
    return { ok: true, surfaces: rows.length };
  },
});

server.addHandler({
  name: 'save-app-settings',
  description: "Replace the app's settings — its settings blob, but for the print window's keys (save-print-settings keeps those) — stored whole under 'settings'.",
  parameters: {
    settingsJson: { description: "JSON object: the app's SettingsConfig. printScope, printRegisters and the old parkingPrint are left out", type: 'string' },
  },
  execute: async (args) => {
    const cfg = parseObject(args.settingsJson, 'settingsJson', MAX_SETTINGS_CHARS);
    // The print keys have their own row, which anyone who prints may write: a copy here would be a
    // second source of them, and one written under different rules.
    const kept = Object.fromEntries(Object.entries(cfg).filter(([key]) => PRINT_KEYS.indexOf(key) === -1 && LEGACY_PRINT_KEYS.indexOf(key) === -1));

    const db = connect();
    const by = (await settingsWriter(db)).name;
    writeAppSetting(db, SETTINGS_ROW, kept, by);
    return { ok: true, keys: Object.keys(kept).length };
  },
});

server.addHandler({
  name: 'save-print-settings',
  description: "Replace the print window's settings (printScope, printRegisters), stored under 'print'. Open to anyone Facilio can name: the window keeps them for everyone who prints.",
  parameters: {
    printJson: { description: 'JSON object: { printScope?, printRegisters?: { workstation|parking|locker|room: { register, cols, rows, sort } } }', type: 'string' },
  },
  execute: async (args) => {
    const print = cleanPrint(parseObject(args.printJson, 'printJson', MAX_PRINT_CHARS));

    // Who, for the record — any caller Facilio names may print, so any may set what prints. The
    // profile alone: whether their role is an admin one decides nothing here.
    const by = (await profileOf()).name;
    writeAppSetting(connect(), PRINT_ROW, print, by);
    return { ok: true };
  },
});

server.addHandler({
  name: 'save-department-colors',
  description: "Replace the department colour scheme, stored under 'departmentColors': department id -> { name, color }.",
  parameters: {
    colorsJson: { description: 'JSON object of department id -> { name, color: "#RRGGBB" } — every department coloured, changed or not', type: 'string' },
  },
  execute: async (args) => {
    const raw = parseObject(args.colorsJson, 'colorsJson');
    const entries = Object.entries(raw);
    if (entries.length > MAX_DEPARTMENTS) throw new Error(`colorsJson has ${entries.length} departments — at most ${MAX_DEPARTMENTS}`);
    // An id is the department's record id, or the app's `name:…` stand-in for a department the
    // record names without an id; a name may be blank (the app does not always know it).
    const scheme = Object.fromEntries(
      entries.map(([id, v]) => {
        if (!id || id.length > MAX_DEPARTMENT_TEXT) throw new Error(`a department id must be 1 to ${MAX_DEPARTMENT_TEXT} characters`);
        if (!isObject(v)) throw new Error(`department ${id}: expected { name, color }`);
        if (typeof v.color !== 'string' || !HEX.test(v.color)) throw new Error(`department ${id}: colour must be #RRGGBB`);
        const name = v.name ?? '';
        if (typeof name !== 'string' || name.length > MAX_DEPARTMENT_TEXT) throw new Error(`department ${id}: the name must be text of at most ${MAX_DEPARTMENT_TEXT} characters`);
        // The colour as sent: the app compares colours as text, against its own lower-case palette.
        return [id, { name, color: v.color }];
      })
    );

    const db = connect();
    const by = (await settingsWriter(db)).name;
    writeAppSetting(db, COLORS_ROW, scheme, by);
    return { ok: true, departments: entries.length };
  },
});

server.execute();
