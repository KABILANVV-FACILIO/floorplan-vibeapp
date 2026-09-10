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
  // Credentials are injected into the run's env map by the platform — never hardcoded, and never
  // sent from the browser. Host/port/database are fixed by the platform to this app's own schema.
  const db = new StudioDatabase({
    userName: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
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
