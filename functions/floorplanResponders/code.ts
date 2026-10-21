import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

/**
 * floorplanResponders — who the org's first responders are, held in the app's own database.
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
 *
 * NO DDL HERE, by necessity: the app's database login holds DML only (USAGE + SELECT / INSERT /
 * UPDATE / DELETE — vibe-server provisions it with WRITE, and WRITE grants no CREATE), so even
 * `create table if not exists` is refused. The tables were made once with `facilio vibe db import`
 * from the CSVs in ./tables, which is also why every row column is text: a CSV column whose values
 * all look numeric becomes numeric, so each table was seeded with a `__seed__` row — reads skip it
 * and the first save removes it.
 *
 * NO TRANSACTIONS either (one connection per query), so every replace is ONE statement: a
 * data-modifying CTE deletes the old set and inserts the new one, which Postgres runs atomically.
 * A failed save leaves the previous set whole rather than half of each.
 *
 * Handler parameters may only be string or number, so lists travel as JSON strings.
 */

const server = new StudioFunctions({ name: 'floorplanResponders' });

const SEED = '__seed__';
const ICONS = ['cross', 'warden', 'flame', 'aed', 'shield', 'megaphone', 'radiation', 'drop', 'star', 'phone', 'bell', 'text'];
const SHAPES = ['square', 'circle', 'diamond'];
const HEX = /^#[0-9a-fA-F]{6}$/;

function connect() {
  // vibe-server puts the app's database login into every run's env (FunctionRunUtil.buildEnv).
  return new StudioDatabase({ userName: process.env.DB_USER, password: process.env.DB_PASSWORD, schema: process.env.SCHEMA });
}

function parseList(raw: unknown, what: string): Record<string, unknown>[] {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`${what} is required`);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (!Array.isArray(v)) throw new Error(`${what} must be a JSON array`);
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
  const { rows } = db.query(
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

server.addHandler({
  name: 'get-responders',
  description: 'The org\'s responder roles in order, and every responder with their roles: { roles: [{id,name,plural,color,icon,shape,text?}], responders: [{employeeId,name,roles}] }.',
  parameters: {},
  execute: async () => {
    const db = connect();
    const roles = readRoles(db);
    const order = roles.map((r) => r.id);

    const members = db.query(`select employee_id, role_id from fp_employee_responder_role where employee_id <> $1`, [SEED]).rows;
    const details = db.query(`select employee_id, employee_name from fp_responder_detail where employee_id <> $1`, [SEED]).rows;

    const rolesOf = new Map<string, string[]>();
    for (const m of members) {
      const id = String(m.employee_id ?? '');
      const role = String(m.role_id ?? '');
      if (!id || order.indexOf(role) === -1) continue; // a role since removed
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
  },
});

server.addHandler({
  name: 'save-roles',
  description: 'Replace every responder role with the supplied list, in order. A role left out also drops off everyone who held it.',
  parameters: {
    rolesJson: { description: 'JSON array of {id,name,plural,color,icon,shape,text?}, in display order', type: 'string' },
    updatedBy: { description: 'Who made the change — the signed-in user, as the app knows them', type: 'string' },
  },
  execute: async (args) => {
    const seen: string[] = [];
    const rows = parseList(args.rolesJson, 'rolesJson').map((r, i) => {
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

    const db = connect();
    const at = new Date().toISOString();
    const by = String(args.updatedBy ?? '');
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
    updatedBy: { description: 'Who made the change — the signed-in user, as the app knows them', type: 'string' },
  },
  execute: async (args) => {
    const byId = new Map<string, { employee_id: string; employee_name: string; roles: string[] }>();
    for (const r of parseList(args.respondersJson, 'respondersJson')) {
      const employeeId = str(r.employeeId, 40);
      const roles = Array.isArray(r.roles) ? (r.roles.map((x) => str(x, 80)).filter(Boolean) as string[]) : [];
      if (!employeeId || roles.length === 0) continue;
      const prev = byId.get(employeeId);
      if (prev) {
        for (const role of roles) if (prev.roles.indexOf(role) === -1) prev.roles.push(role);
        continue;
      }
      byId.set(employeeId, { employee_id: employeeId, employee_name: str(r.name) ?? '', roles });
    }
    const people = [...byId.values()];

    const db = connect();
    const at = new Date().toISOString();
    const by = String(args.updatedBy ?? '');
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

server.execute();
