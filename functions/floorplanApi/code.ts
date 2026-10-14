import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

/**
 * floorplanApi — every app-owned record for the Floorplan Manager vibe app.
 *
 * The browser has no database access of its own: the vibe DB is a per-app Postgres schema and the
 * only way in is a function handler, so this file IS the app's data tier. Org records (portfolio,
 * people, assets) do NOT live here — those come from the facilio-cmms connector. What lives here is
 * everything the org has no home for: on-plan placement geometry, this app's assignments and
 * bookings, its settings, and uploaded floorplan files.
 *
 * Handler parameters may only be declared `string` or `number` (the build rejects anything else),
 * so composite payloads travel as JSON strings and are parsed here.
 */

const server = new StudioFunctions({ name: 'floorplanApi' });

const DDL = [
  `create table if not exists fp_unit (
     id text primary key,
     floor_id text not null,
     plan_id text not null default '',
     data text not null
   )`,
  `create index if not exists fp_unit_floor_idx on fp_unit (floor_id)`,
  `create table if not exists fp_assignment (
     unit_id text primary key,
     employee_id text not null
   )`,
  `create table if not exists fp_booking (
     id text primary key,
     unit_id text not null,
     booking_date text not null,
     data text not null
   )`,
  `create index if not exists fp_booking_date_idx on fp_booking (booking_date)`,
  `create table if not exists fp_settings (
     id integer primary key,
     config text not null
   )`,
  /*
   * Department -> marker colour, one row per department, keyed by the DEPARTMENT RECORD's id in
   * the org rather than its name: renaming a department in Facilio must not lose its colour, and
   * two orgs' "Operations" are not the same thing.
   *
   * A table of its own rather than a key inside fp_settings, so anything else that needs the
   * org's colour scheme — a report, another app, a later export — can read it as data instead of
   * unpacking this app's settings blob. `department_name` rides along for exactly that reader:
   * it makes a row legible without a lookup back into Facilio.
   */
  `create table if not exists fp_department_color (
     department_id text primary key,
     department_name text not null default '',
     color text not null,
     updated_at text not null default ''
   )`,
  /*
   * Who may see what. TWO tables, because "everyone" and "these 7 roles" are different facts.
   *
   * A SURFACE is a tab, or a mode within the floorplan tab — the things a person either sees or
   * does not. Dotted keys are a mode of their parent tab:
   *
   *   map            the floorplan tab          bookings   the bookings calendar
   *   map.assign     its Assign mode            people     the people directory
   *   map.book       its Book mode              settings   the settings screen
   *   map.edit       its Edit mode
   *
   * fp_surface carries `all_roles` per surface. It is NOT shorthand for "write a row for each of
   * the org's roles": an org has dozens of roles and adds more, and a surface open to everyone
   * must stay open to a role created next month. Stored as a list, every new role would silently
   * arrive denied.
   *
   * fp_permission carries the explicit grants, one row per (surface, role), and is read only when
   * that surface's all_roles is 0. Roles are the ORG's, so no role list is hardcoded here —
   * whatever id the app sends is stored as given.
   *
   * `allowed` / `all_roles` are 0/1 rather than booleans: handler parameters may only be string or
   * number, and keeping the columns the same shape as the wire value means no translation to get
   * wrong.
   *
   * Absence is NOT denial — a surface with no fp_surface record falls back to the client's own
   * default, so an org that never opens the grid behaves exactly as it does today.
   */
  `create table if not exists fp_surface (
     surface text primary key,
     all_roles integer not null default 0,
     updated_at text not null default '',
     updated_by text not null default ''
   )`,
  `create table if not exists fp_permission (
     surface text not null,
     role text not null,
     allowed integer not null default 0,
     updated_at text not null default '',
     updated_by text not null default '',
     primary key (surface, role)
   )`,
  `create index if not exists fp_permission_role_idx on fp_permission (role)`,
  `create table if not exists fp_floorplan_file (
     floor_id text not null,
     plan_id text not null,
     data text not null,
     primary key (floor_id, plan_id)
   )`,
];

/**
 * Memoized across calls that share a sandbox instance. The DDL is idempotent, so a cold instance
 * paying for it again is only a cost, never a correctness problem — which is why the app needs no
 * separate install step before its first write.
 */
let schemaReady = false;

function connect() {
  // vibe-server puts this app's database login into every run's env map
  // (FunctionRunUtil.buildEnv): SCHEMA, DB_USER, DB_PASSWORD — never hardcoded, never sent from the
  // browser. SCHEMA is the app's own schema (vibe_<app uuid>, from `facilio vibe db create`), set as
  // the connection's search_path so the plain table names below resolve inside it.
  const db = new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
  if (!schemaReady) {
    for (const stmt of DDL) db.query(stmt);
    schemaReady = true;
  }
  return db;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('invalid JSON payload');
  }
}

function unitsOnFloor(db: any, floorId: string): unknown[] {
  const { rows } = db.query('select data from fp_unit where floor_id = $1', [floorId]);
  return rows.map((r: any) => JSON.parse(r.data));
}

function assignmentsOnFloor(db: any, floorId: string): Record<string, string> {
  // Scoped by joining the placement table rather than denormalizing a floor onto the assignment:
  // a unit's floor can change, and the join can't go stale.
  const { rows } = db.query(
    `select a.unit_id, a.employee_id
       from fp_assignment a
       join fp_unit u on u.id = a.unit_id
      where u.floor_id = $1`,
    [floorId]
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.unit_id] = r.employee_id;
  return out;
}

function bookingsOnFloor(db: any, floorId: string, date: string): unknown[] {
  const { rows } = db.query(
    `select b.data
       from fp_booking b
       join fp_unit u on u.id = b.unit_id
      where u.floor_id = $1 and b.booking_date = $2`,
    [floorId, date]
  );
  return rows.map((r: any) => JSON.parse(r.data));
}

function storedFile(db: any, floorId: string, planId: string): string | null {
  const { rows } = db.query('select data from fp_floorplan_file where floor_id = $1 and plan_id = $2', [floorId, planId]);
  return rows.length ? rows[0].data : null;
}

server.addHandler({
  name: 'init-schema',
  description: 'Create the app tables if they do not exist yet (idempotent).',
  parameters: {},
  execute: async () => {
    connect();
    return { ok: true, tables: ['fp_unit', 'fp_assignment', 'fp_booking', 'fp_settings', 'fp_floorplan_file'] };
  },
});

server.addHandler({
  name: 'get-floor-data',
  description: 'Units, assignments, bookings and the stored floorplan file for one floor, in a single round trip.',
  parameters: {
    floorId: { description: 'Floor record id', type: 'string' },
    date: { description: 'Booking day, YYYY-MM-DD', type: 'string' },
    planId: { description: 'Plan type: workstation | locker | parking | custom', type: 'string' },
  },
  execute: async (args) => {
    const db = connect();
    return {
      units: unitsOnFloor(db, args.floorId),
      assignments: assignmentsOnFloor(db, args.floorId),
      bookings: bookingsOnFloor(db, args.floorId, args.date),
      file: storedFile(db, args.floorId, args.planId),
    };
  },
});

server.addHandler({
  name: 'get-units',
  description: 'Placed units for one floor.',
  parameters: { floorId: { description: 'Floor record id', type: 'string' } },
  execute: async (args) => unitsOnFloor(connect(), args.floorId),
});

server.addHandler({
  name: 'save-units',
  description: "Replace a floor's placed units with the supplied set.",
  parameters: {
    floorId: { description: 'Floor record id', type: 'string' },
    unitsJson: { description: 'JSON array of Unit objects', type: 'string' },
  },
  execute: async (args) => {
    const units = parseJson<any[]>(args.unitsJson, []);
    if (!Array.isArray(units)) throw new Error('unitsJson must be a JSON array');
    const db = connect();
    db.query('delete from fp_unit where floor_id = $1', [args.floorId]);
    if (units.length) {
      // One multi-row insert instead of one query per unit: the host serializes every query, so a
      // 40-desk floor would otherwise cost 40 sequential round trips.
      const values: string[] = [];
      const params: unknown[] = [];
      units.forEach((u, i) => {
        const b = i * 4;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
        params.push(String(u.id), args.floorId, String(u.plan ?? ''), JSON.stringify(u));
      });
      db.query(`insert into fp_unit (id, floor_id, plan_id, data) values ${values.join(', ')}`, params);
    }
    return { ok: true, saved: units.length };
  },
});

server.addHandler({
  name: 'get-assignments',
  description: 'unitId -> employeeId for every assigned unit on one floor.',
  parameters: { floorId: { description: 'Floor record id', type: 'string' } },
  execute: async (args) => assignmentsOnFloor(connect(), args.floorId),
});

server.addHandler({
  name: 'assign-unit',
  description: 'Assign a unit to an employee (replaces any existing holder).',
  parameters: {
    unitId: { description: 'Unit id', type: 'string' },
    employeeId: { description: 'Employee record id', type: 'string' },
  },
  execute: async (args) => {
    connect().query(
      `insert into fp_assignment (unit_id, employee_id) values ($1, $2)
       on conflict (unit_id) do update set employee_id = excluded.employee_id`,
      [args.unitId, args.employeeId]
    );
    return { ok: true };
  },
});

server.addHandler({
  name: 'vacate-unit',
  description: 'Clear a unit assignment.',
  parameters: { unitId: { description: 'Unit id', type: 'string' } },
  execute: async (args) => {
    connect().query('delete from fp_assignment where unit_id = $1', [args.unitId]);
    return { ok: true };
  },
});

server.addHandler({
  name: 'get-bookings',
  description: 'Bookings for one floor on one day.',
  parameters: {
    floorId: { description: 'Floor record id', type: 'string' },
    date: { description: 'Booking day, YYYY-MM-DD', type: 'string' },
  },
  execute: async (args) => bookingsOnFloor(connect(), args.floorId, args.date),
});

server.addHandler({
  name: 'create-booking',
  description: 'Store a booking. Returns the stored record, id included.',
  parameters: { bookingJson: { description: 'JSON Booking object (id optional)', type: 'string' } },
  execute: async (args) => {
    const booking = parseJson<any>(args.bookingJson, null);
    if (!booking || !booking.unitId || !booking.date) throw new Error('bookingJson needs at least unitId and date');
    const id = String(booking.id || `b${Date.now()}`);
    const stored = { ...booking, id };
    connect().query(
      `insert into fp_booking (id, unit_id, booking_date, data) values ($1, $2, $3, $4)
       on conflict (id) do update set unit_id = excluded.unit_id, booking_date = excluded.booking_date, data = excluded.data`,
      [id, String(booking.unitId), String(booking.date), JSON.stringify(stored)]
    );
    return stored;
  },
});

server.addHandler({
  name: 'cancel-booking',
  description: 'Delete a booking by id.',
  parameters: { id: { description: 'Booking id', type: 'string' } },
  execute: async (args) => {
    connect().query('delete from fp_booking where id = $1', [args.id]);
    return { ok: true };
  },
});

server.addHandler({
  name: 'get-department-colors',
  description: 'Every configured department colour, as [{departmentId, departmentName, color}].',
  parameters: {},
  execute: async () => {
    const { rows } = connect().query('select department_id, department_name, color from fp_department_color');
    return rows.map((r: any) => ({ departmentId: r.department_id, departmentName: r.department_name, color: r.color }));
  },
});

server.addHandler({
  name: 'save-department-color',
  description: 'Set one department\'s marker colour (upsert by department id).',
  parameters: {
    departmentId: { description: 'Department record id in the org', type: 'string' },
    departmentName: { description: 'Department name, stored so a row reads without a lookup', type: 'string' },
    color: { description: 'Hex colour, e.g. #0059d6', type: 'string' },
  },
  execute: async (args) => {
    const id = String(args.departmentId ?? '').trim();
    const color = String(args.color ?? '').trim();
    if (!id) throw new Error('departmentId is required');
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('color must be a #rrggbb hex value');
    connect().query(
      `insert into fp_department_color (department_id, department_name, color, updated_at)
       values ($1, $2, $3, $4)
       on conflict (department_id) do update set
         department_name = excluded.department_name,
         color = excluded.color,
         updated_at = excluded.updated_at`,
      [id, String(args.departmentName ?? ''), color, new Date().toISOString()]
    );
    return { ok: true };
  },
});

server.addHandler({
  name: 'clear-department-color',
  description: 'Drop one department\'s colour, so it falls back to the app\'s default wheel.',
  parameters: { departmentId: { description: 'Department record id in the org', type: 'string' } },
  execute: async (args) => {
    connect().query('delete from fp_department_color where department_id = $1', [String(args.departmentId ?? '')]);
    return { ok: true };
  },
});

/** Every surface the grid governs: the four tabs, plus the floorplan's three modes. */
const SURFACES = ['map', 'map.assign', 'map.book', 'map.edit', 'bookings', 'people', 'settings'];

/**
 * The TABS a person navigates between. The floorplan's modes are deliberately not here: a mode is
 * only reachable through `map`, so a role holding only `map.edit` still has somewhere to land.
 */
const TABS = ['map', 'bookings', 'people', 'settings'];

/**
 * Settings is never taken from these, whatever is stored or sent. Without this floor a single bad
 * write locks the only people who could undo it out of the screen that undoes it, and recovery
 * would be a database edit. Enforced here rather than in the browser so no client bug, and no
 * direct call to this function, can get past it.
 */
const ALWAYS_SETTINGS = ['super-admin', 'administrator'];

/** Roles are the ORG's — dozens of them, and more tomorrow. None are hardcoded. */
function readGrid(db: any): Record<string, { all: boolean; roles: string[] }> {
  const out: Record<string, { all: boolean; roles: string[] }> = {};
  const surfaces = db.query('select surface, all_roles from fp_surface');
  for (const r of surfaces.rows) out[String(r.surface)] = { all: Number(r.all_roles) === 1, roles: [] };
  const grants = db.query('select surface, role from fp_permission where allowed = 1');
  for (const r of grants.rows) {
    const key = String(r.surface);
    if (!out[key]) out[key] = { all: false, roles: [] };
    out[key].roles.push(String(r.role));
  }
  for (const role of ALWAYS_SETTINGS) {
    if (!out.settings) out.settings = { all: false, roles: [] };
    if (!out.settings.all && out.settings.roles.indexOf(role) === -1) out.settings.roles.push(role);
  }
  return out;
}

/** Does `role` still reach at least one TAB under `grid`? */
function hasAnyTab(grid: Record<string, { all: boolean; roles: string[] }>, role: string): boolean {
  for (const tab of TABS) {
    const cell = grid[tab];
    if (!cell) continue;
    if (cell.all || cell.roles.indexOf(role) !== -1) return true;
  }
  return false;
}

/**
 * Every role named anywhere in the grid must keep a tab. A role with none has nothing to open:
 * the app would authenticate them and then show an empty shell, which reads as broken rather than
 * as configured. Refused here as well as in the browser, for the same reason as the Settings floor.
 */
function assertEveryRoleHasATab(grid: Record<string, { all: boolean; roles: string[] }>): void {
  const named: string[] = [];
  for (const key of Object.keys(grid)) {
    for (const role of grid[key].roles) if (named.indexOf(role) === -1) named.push(role);
  }
  const stranded = named.filter((role) => !hasAnyTab(grid, role));
  if (stranded.length) {
    throw new Error('these roles would be left with no tab at all: ' + stranded.join(', '));
  }
}

function writeSurface(db: any, surface: string, all: boolean, roles: string[], at: string, by: string): void {
  db.query(
    `insert into fp_surface (surface, all_roles, updated_at, updated_by)
     values ($1, $2, $3, $4)
     on conflict (surface) do update set
       all_roles = excluded.all_roles,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [surface, all ? 1 : 0, at, by]
  );
  // A role dropped from the list is DENIED rather than deleted, so the log can still show that it
  // was turned off and by whom.
  db.query('update fp_permission set allowed = 0, updated_at = $2, updated_by = $3 where surface = $1 and allowed = 1', [surface, at, by]);
  for (const role of roles) {
    db.query(
      `insert into fp_permission (surface, role, allowed, updated_at, updated_by)
       values ($1, $2, 1, $3, $4)
       on conflict (surface, role) do update set
         allowed = 1,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [surface, role, at, by]
    );
  }
}

server.addHandler({
  name: 'get-permissions',
  description: "The grid as the app reads it on load: { map: { all: true, roles: [] }, people: { all: false, roles: ['hr-director', ...] } }. `all` means every role the org has, including ones added later. Settings always carries super-admin and administrator. A surface with no record is absent, and the client falls back to its own default for it.",
  parameters: {},
  execute: async () => readGrid(connect()),
});

server.addHandler({
  name: 'get-permission-log',
  description: 'Every stored cell with its last change — surface, role, allowed, who changed it and when, newest first; plus the per-surface all_roles flag and its own last change. The audit read; get-permissions is the one the app asks on load.',
  parameters: {},
  execute: async () => {
    const db = connect();
    const grants = db.query(
      'select surface, role, allowed, updated_at, updated_by from fp_permission order by updated_at desc, surface, role'
    );
    const surfaces = db.query(
      'select surface, all_roles, updated_at, updated_by from fp_surface order by updated_at desc, surface'
    );
    return {
      surfaces: surfaces.rows.map((r: any) => ({
        surface: String(r.surface),
        allRoles: Number(r.all_roles) === 1,
        updatedAt: String(r.updated_at ?? ''),
        updatedBy: String(r.updated_by ?? ''),
      })),
      grants: grants.rows.map((r: any) => ({
        surface: String(r.surface),
        role: String(r.role),
        allowed: Number(r.allowed) === 1,
        updatedAt: String(r.updated_at ?? ''),
        updatedBy: String(r.updated_by ?? ''),
      })),
    };
  },
});

server.addHandler({
  name: 'set-surface-access',
  description: "Set one surface's audience in a single write: either every role, or an explicit list. Refused if it would strand a named role with no tab, or strip Settings from super-admin or administrator.",
  parameters: {
    surface: { description: 'Surface key: map | map.assign | map.book | map.edit | bookings | people | settings', type: 'string' },
    allRoles: { description: '1 for every role the org has (now and later), 0 for the explicit list', type: 'number' },
    rolesJson: { description: 'JSON array of role ids, used when allRoles is 0', type: 'string' },
    updatedBy: { description: 'Who made the change — the signed-in user, as the app knows them', type: 'string' },
  },
  execute: async (args) => {
    const surface = String(args.surface ?? '').trim();
    if (SURFACES.indexOf(surface) === -1) throw new Error('unknown surface: ' + surface);
    const all = Number(args.allRoles) === 1;
    const roles = all ? [] : parseJson<string[]>(args.rolesJson, []).map(String).filter((r) => r !== '');
    if (surface === 'settings' && !all) {
      for (const role of ALWAYS_SETTINGS) if (roles.indexOf(role) === -1) roles.push(role);
    }

    const db = connect();
    const grid = readGrid(db);
    grid[surface] = { all, roles };
    assertEveryRoleHasATab(grid);

    writeSurface(db, surface, all, roles, new Date().toISOString(), String(args.updatedBy ?? ''));
    return { ok: true, surface, allRoles: all, roles };
  },
});

server.addHandler({
  name: 'save-permissions',
  description: 'Replace the whole grid in one write, from the same shape get-permissions returns. Refused as a whole if it would strand a named role with no tab.',
  parameters: {
    gridJson: { description: 'JSON object of surface -> { all: boolean, roles: string[] }', type: 'string' },
    updatedBy: { description: 'Who made the change — the signed-in user, as the app knows them', type: 'string' },
  },
  execute: async (args) => {
    const grid = parseJson<Record<string, { all?: boolean; roles?: string[] }>>(args.gridJson, null as any);
    if (!grid || typeof grid !== 'object') throw new Error('gridJson must be a JSON object');

    const next: Record<string, { all: boolean; roles: string[] }> = {};
    for (const surface of Object.keys(grid)) {
      if (SURFACES.indexOf(surface) === -1) throw new Error('unknown surface: ' + surface);
      const all = grid[surface]?.all === true;
      const roles = all ? [] : (Array.isArray(grid[surface]?.roles) ? grid[surface]!.roles!.map(String) : []).filter((r) => r !== '');
      if (surface === 'settings' && !all) {
        for (const role of ALWAYS_SETTINGS) if (roles.indexOf(role) === -1) roles.push(role);
      }
      next[surface] = { all, roles };
    }
    assertEveryRoleHasATab(next);

    const db = connect();
    const at = new Date().toISOString();
    const by = String(args.updatedBy ?? '');
    let written = 0;
    for (const surface of Object.keys(next)) {
      writeSurface(db, surface, next[surface].all, next[surface].roles, at, by);
      written += 1;
    }
    return { ok: true, surfaces: written };
  },
});

server.addHandler({
  name: 'get-settings',
  description: "The app's persisted settings blob, or null if never saved.",
  parameters: {},
  execute: async () => {
    const { rows } = connect().query('select config from fp_settings where id = 1');
    return rows.length ? JSON.parse(rows[0].config) : null;
  },
});

server.addHandler({
  name: 'save-settings',
  description: 'Persist the settings blob (single row, overwritten).',
  parameters: { configJson: { description: 'JSON settings object', type: 'string' } },
  execute: async (args) => {
    const cfg = parseJson<any>(args.configJson, null);
    if (!cfg) throw new Error('configJson must be a JSON object');
    connect().query(
      `insert into fp_settings (id, config) values (1, $1)
       on conflict (id) do update set config = excluded.config`,
      [JSON.stringify(cfg)]
    );
    return { ok: true };
  },
});

server.addHandler({
  name: 'get-floorplan-file',
  description: 'The stored floorplan file record for a floor + plan type.',
  parameters: {
    floorId: { description: 'Floor record id', type: 'string' },
    planId: { description: 'Plan type', type: 'string' },
  },
  execute: async (args) => {
    const raw = storedFile(connect(), args.floorId, args.planId);
    return raw ? JSON.parse(raw) : null;
  },
});

server.addHandler({
  name: 'save-floorplan-file',
  description: 'Store the floorplan file record (vibe fileId + render metadata) for a floor + plan type.',
  parameters: {
    floorId: { description: 'Floor record id', type: 'string' },
    planId: { description: 'Plan type', type: 'string' },
    fileJson: { description: 'JSON StoredFloorplanFile object', type: 'string' },
  },
  execute: async (args) => {
    const file = parseJson<any>(args.fileJson, null);
    if (!file) throw new Error('fileJson must be a JSON object');
    connect().query(
      `insert into fp_floorplan_file (floor_id, plan_id, data) values ($1, $2, $3)
       on conflict (floor_id, plan_id) do update set data = excluded.data`,
      [args.floorId, args.planId, JSON.stringify(file)]
    );
    return { ok: true };
  },
});

server.addHandler({
  name: 'list-floorplan-floors',
  description: 'Floor ids that have at least one stored floorplan file (keys only, no payloads).',
  parameters: {},
  execute: async () => {
    const { rows } = connect().query('select distinct floor_id from fp_floorplan_file');
    return rows.map((r: any) => r.floor_id);
  },
});

server.execute();
