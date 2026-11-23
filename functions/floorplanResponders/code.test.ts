// @vitest-environment node
// The function runs in Vibe's server runtime, never a browser: no DOM here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * floorplanResponders' writes: who may save, and what a save may hold. The function runs in Vibe's
 * runtime, not here, so its two seams are stood in for — the app database (StudioDatabase) and the
 * connection calls that say who is calling (fetch to CONNECTIONS_URL). Everything between them is
 * the function's own code, run as it is.
 */

type Handler = { name: string; execute: (args: Record<string, unknown>) => Promise<any> };
const fn = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  queries: [] as { sql: string; params?: unknown[] }[],
  accessRows: [] as { surface: string; all_roles: number; roles: string }[],
  /** What each StudioDatabase was opened with — the run's own login, never one the browser sends. */
  opened: [] as Record<string, unknown>[],
  /** When set, every read answers capped (`truncated`), as the database does for a large result. */
  truncated: false,
  /** fp_app_setting's rows, as the read selects them. */
  appSettingRows: [] as { setting_key: string; value_json: string }[],
  /** Before `facilio vibe db import` made fp_app_setting, a select from it fails. */
  missingAppSettingTable: false,
  /** fp_app_setting's read alone answers capped. */
  appSettingTruncated: false,
  /** fp_app_setting's read fails with this — a timeout, say — rather than answer. */
  appSettingError: null as Error | null,
  /** fp_responder_role / fp_employee_responder_role / fp_responder_detail rows, as their reads select them. */
  roleRows: [] as Record<string, unknown>[],
  memberRows: [] as { employee_id: string; role_id: string }[],
  detailRows: [] as { employee_id: string; employee_name: string }[],
}));

vi.mock('@facilio/studio-functions', () => ({
  default: class {
    addHandler(h: Handler) {
      fn.handlers.set(h.name, h);
    }
    execute() {}
  },
  StudioDatabase: class {
    constructor(opts: Record<string, unknown>) {
      fn.opened.push(opts);
    }
    query(sql: string, params?: unknown[]) {
      fn.queries.push({ sql, params });
      const truncated = fn.truncated && /^\s*select/.test(sql);
      if (/^\s*select surface, all_roles, roles from fp_access/.test(sql)) return { rows: fn.accessRows, truncated };
      if (/^\s*select setting_key, value_json from fp_app_setting/.test(sql)) {
        if (fn.missingAppSettingTable) throw new Error('relation "fp_app_setting" does not exist');
        if (fn.appSettingError) throw fn.appSettingError;
        // Capped only when the settings row is asked for — it is the one that grows.
        const keys = (params ?? []).map(String);
        return { rows: fn.appSettingRows.filter((r) => keys.includes(String(r.setting_key))), truncated: truncated || (fn.appSettingTruncated && keys.includes('settings')) };
      }
      if (/^\s*select id, name, plural, color, icon, shape, badge_text from fp_responder_role/.test(sql)) return { rows: fn.roleRows, truncated };
      if (/^\s*select employee_id, role_id from fp_employee_responder_role/.test(sql)) return { rows: fn.memberRows, truncated };
      if (/^\s*select employee_id, employee_name from fp_responder_detail/.test(sql)) return { rows: fn.detailRows, truncated };
      return { rows: [], truncated };
    }
  },
}));

// ENEC's roles, trimmed: two admin roles (one flagged only as privileged) and one that is not.
const ROLES = [
  { id: 3873, name: 'CAFM Super Administrator', isSuperAdmin: true, isPrivileged: true },
  { id: 3874, name: 'CAFM Administrator', isPrivileged: true },
  { id: 4215, name: 'ENEC Executive', isPrivileged: false },
];
let callerRole = 3874;
/** What list-roles answers with: 200 and the roles, or a refusal (429 when Facilio is busy). */
let listRolesStatus = 200;
const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('list-roles') && listRolesStatus !== 200) return { ok: false, status: listRolesStatus, json: async () => null };
  const answer = url.includes('get-current-user-profile')
    ? { data: { user: { id: 1, name: 'Test Admin', role: { id: callerRole } }, app: { linkName: 'maintenance' } } }
    : url.includes('list-roles')
      ? { data: ROLES }
      : null;
  return { ok: !!answer, status: answer ? 200 : 404, json: async () => answer };
});
vi.stubGlobal('fetch', fetchMock);
(process as unknown as { system: Record<string, string> }).system = { CONNECTIONS_URL: 'https://connections.test' };
process.env.DB_USER = 'app_login';
process.env.DB_PASSWORD = 'app_secret';
process.env.SCHEMA = 'app_schema';

await import('./code');
const run = (name: string, args: Record<string, unknown> = {}) => fn.handlers.get(name)!.execute(args);
const writes = () => fn.queries.filter((q) => /insert into/.test(q.sql));
const grid = (g: Record<string, { all: boolean; roles: string[] }>) => ({ accessJson: JSON.stringify(g) });

beforeEach(() => {
  fn.queries.length = 0;
  fn.opened.length = 0;
  fn.accessRows = [];
  fn.truncated = false;
  fn.appSettingRows = [];
  fn.missingAppSettingTable = false;
  fn.appSettingTruncated = false;
  fn.appSettingError = null;
  fn.roleRows = [];
  fn.memberRows = [];
  fn.detailRows = [];
  callerRole = 3874;
  listRolesStatus = 200;
  fetchMock.mockClear();
});

/** The two built-in roles, as the screen always sends them (lib/firstResponders sanitizeRoles). */
const BUILT_INS = [
  { id: 'firstAider', name: 'First aider', plural: 'First aiders', color: '#00843d', icon: 'cross', shape: 'square' },
  { id: 'floorWarden', name: 'Floor warden', color: '#C8102E', icon: 'warden', shape: 'circle' },
];
const roles = (list: unknown[]) => ({ rolesJson: JSON.stringify(list) });
const identityCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('get-current-user-profile'));

describe('saving the Roles & access grid', () => {
  it('takes the rights on the plan and the calendar, from an admin', async () => {
    const res = await run('save-access', grid({ 'map.assign': { all: false, roles: ['4215'] }, 'map.book': { all: true, roles: [] }, 'bookings.book': { all: false, roles: ['4215'] } }));
    expect(res).toEqual({ ok: true, surfaces: 3 });
    const [write] = writes();
    expect(JSON.parse(String(write.params![0])).map((r: { surface: string }) => r.surface)).toEqual(['map.assign', 'map.book', 'bookings.book']);
    expect(write.params![2]).toBe('Test Admin'); // who Facilio says is calling, whatever the browser sends
  });

  it('refuses a surface it does not know, and writes nothing', async () => {
    await expect(run('save-access', grid({ 'map.delete': { all: true, roles: [] } }))).rejects.toThrow('unknown surface: map.delete');
    expect(writes()).toHaveLength(0);
  });

  it('refuses a role that is not an admin and was not given Settings', async () => {
    callerRole = 4215;
    await expect(run('save-access', grid({ map: { all: true, roles: [] } }))).rejects.toThrow(/only admins and roles given Settings/);
    expect(writes()).toHaveLength(0);
  });

  it('takes it from a role the stored grid gives Settings', async () => {
    callerRole = 4215;
    fn.accessRows = [{ surface: 'settings', all_roles: 0, roles: '["4215"]' }];
    await expect(run('save-access', grid({ map: { all: true, roles: [] } }))).resolves.toEqual({ ok: true, surfaces: 1 });
  });

  it('refuses when Facilio cannot say who is calling', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 401, json: async () => null }));
    await expect(run('save-access', grid({ map: { all: true, roles: [] } }))).rejects.toThrow(/could not confirm who is signed in/);
    expect(writes()).toHaveLength(0);
  });

  it('tells an admin Facilio is busy — not that only admins may — when the role list is refused, and writes nothing', async () => {
    listRolesStatus = 429;
    await expect(run('save-access', grid({ map: { all: true, roles: [] } }))).rejects.toThrow('Not saved: could not confirm your role, Facilio is busy. Try again in a minute');
    expect(writes()).toHaveLength(0);
  });

  it('still takes it from a role the grid names when the role list is refused', async () => {
    listRolesStatus = 429;
    callerRole = 4215;
    fn.accessRows = [{ surface: 'settings', all_roles: 0, roles: '["4215"]' }];
    await expect(run('save-access', grid({ map: { all: true, roles: [] } }))).resolves.toEqual({ ok: true, surfaces: 1 });
  });
});

describe('saving responders and their roles', () => {
  it('refuses a caller who may not change settings', async () => {
    callerRole = 4215;
    // A list the screen would send — both built-in roles kept — so it is the caller that is refused.
    await expect(run('save-roles', roles(BUILT_INS))).rejects.toThrow(/only admins/);
    await expect(run('save-responders', { respondersJson: JSON.stringify([{ employeeId: '9', name: 'Omar Al Marri', roles: ['firstAider'] }]) })).rejects.toThrow(/only admins/);
    expect(writes()).toHaveLength(0);
  });

  it('refuses a badge it cannot draw before asking who is calling', async () => {
    await expect(run('save-roles', { rolesJson: JSON.stringify([{ id: 'fa', name: 'First aider', color: 'green', icon: 'cross', shape: 'circle' }]) })).rejects.toThrow('colour must be #RRGGBB');
    expect(writes()).toHaveLength(0);
  });

  it('writes the roles in order — colours upper-cased, a missing plural made — recorded as Facilio names the caller', async () => {
    const res = await run('save-roles', roles([...BUILT_INS, { id: 'r_aed', name: 'AED holder', color: '#0059d6', icon: 'text', shape: 'diamond', text: 'AED' }]));
    expect(res).toEqual({ ok: true, roles: 3 });
    const [write] = writes();
    expect(write.sql).toMatch(/insert into fp_responder_role/);
    expect(JSON.parse(String(write.params![0]))).toEqual([
      { id: 'firstAider', name: 'First aider', plural: 'First aiders', color: '#00843D', icon: 'cross', shape: 'square', badge_text: null, sort_order: 1 },
      { id: 'floorWarden', name: 'Floor warden', plural: 'Floor wardens', color: '#C8102E', icon: 'warden', shape: 'circle', badge_text: null, sort_order: 2 },
      { id: 'r_aed', name: 'AED holder', plural: 'AED holders', color: '#0059D6', icon: 'text', shape: 'diamond', badge_text: 'AE', sort_order: 3 },
    ]);
    expect(write.params![2]).toBe('Test Admin');
    // Links and details naming a role that is gone go with it, in the statements after.
    expect(fn.queries.filter((q) => /^\s*delete from fp_(employee_responder_role|responder_detail)/.test(q.sql))).toHaveLength(2);
  });

  it('opens the database with the run\'s own login, from its environment', async () => {
    await run('save-roles', roles(BUILT_INS));
    expect(fn.opened).toEqual([{ userName: 'app_login', password: 'app_secret', schema: 'app_schema' }]);
  });

  it('refuses an empty role list — it would remove every responder in the org — and writes nothing', async () => {
    await expect(run('save-roles', roles([]))).rejects.toThrow(/empty list is refused/);
    expect(fn.queries).toHaveLength(0);
    expect(identityCalls()).toHaveLength(0);
  });

  it('refuses a list without the first aider or the floor warden', async () => {
    await expect(run('save-roles', roles([BUILT_INS[0]]))).rejects.toThrow(/missing: floorWarden/);
    await expect(run('save-roles', roles([BUILT_INS[1], { id: 'r_x', name: 'X', color: '#123456', icon: 'star', shape: 'circle' }]))).rejects.toThrow(/missing: firstAider/);
    expect(fn.queries).toHaveLength(0);
  });

  it('refuses more roles than it keeps, before asking who is calling', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `r_${i}`, name: `Role ${i}`, color: '#123456', icon: 'star', shape: 'circle' }));
    await expect(run('save-roles', roles([...BUILT_INS, ...many]))).rejects.toThrow(/at most 50/);
    expect(identityCalls()).toHaveLength(0);
    expect(fn.queries).toHaveLength(0);
  });

  it('writes the responders — one entry per person, their roles merged — in one statement, as Facilio names the caller', async () => {
    const res = await run('save-responders', {
      respondersJson: JSON.stringify([
        { employeeId: '9', name: 'Omar Al Marri', roles: ['firstAider'] },
        { employeeId: '9', name: 'Omar Al Marri', roles: ['floorWarden', 'firstAider'] },
        { employeeId: '12', name: 'Sara Haddad', roles: ['floorWarden'] },
        { employeeId: '13', name: 'No role', roles: [] },
      ]),
    });
    expect(res).toEqual({ ok: true, responders: 2 });
    const [write] = writes();
    expect(write.sql).toMatch(/insert into fp_responder_detail[\s\S]*insert into fp_employee_responder_role/);
    expect(JSON.parse(String(write.params![0]))).toEqual([
      { employee_id: '9', employee_name: 'Omar Al Marri', roles: ['firstAider', 'floorWarden'] },
      { employee_id: '12', employee_name: 'Sara Haddad', roles: ['floorWarden'] },
    ]);
    expect(write.params![2]).toBe('Test Admin');
  });

  it('refuses 2,001 responders with a clear message, and runs no query', async () => {
    const people = Array.from({ length: 2001 }, (_, i) => ({ employeeId: String(1000 + i), name: `P${i}`, roles: ['firstAider'] }));
    await expect(run('save-responders', { respondersJson: JSON.stringify(people) })).rejects.toThrow(/2001 entries — at most 2000/);
    expect(fn.queries).toHaveLength(0);
    expect(identityCalls()).toHaveLength(0);
  });

  it('refuses a request too large to be a responder list, whatever it holds', async () => {
    await expect(run('save-responders', { respondersJson: `[${'"x",'.repeat(130_000)}"x"]` })).rejects.toThrow(/too large/);
    expect(fn.queries).toHaveLength(0);
  });

  it('refuses an employee id that is not an org record id', async () => {
    await expect(run('save-responders', { respondersJson: JSON.stringify([{ employeeId: 'c1', name: 'Demo person', roles: ['firstAider'] }]) })).rejects.toThrow(/digits only/);
    expect(fn.queries).toHaveLength(0);
  });

  it('refuses a person holding more roles than exist', async () => {
    const lots = Array.from({ length: 51 }, (_, i) => `r_${i}`);
    await expect(run('save-responders', { respondersJson: JSON.stringify([{ employeeId: '9', name: 'Omar', roles: lots }]) })).rejects.toThrow(/at most 50/);
    expect(fn.queries).toHaveLength(0);
  });
});

describe('reading the settings', () => {
  it('refuses an answer the database capped, rather than serve part of a list as the whole', async () => {
    fn.truncated = true;
    await expect(run('get-settings')).rejects.toThrow(/answered only in part/);
  });

  it('reads roles, responders and the grid in one call', async () => {
    fn.accessRows = [{ surface: 'settings', all_roles: 0, roles: '["4215"]' }];
    await expect(run('get-settings')).resolves.toEqual({
      roles: [],
      responders: [],
      access: { settings: { all: false, roles: ['4215'] } },
      appSettingsRead: true,
      appSettings: null,
      printSettings: null,
      departmentColors: null,
    });
  });

  it('reads the stored settings, print settings and colours with them, each parsed', async () => {
    fn.appSettingRows = [
      { setting_key: 'settings', value_json: '{"colorBy":"department"}' },
      { setting_key: 'print', value_json: '{"printScope":"floor"}' },
      { setting_key: 'departmentColors', value_json: '{"10":{"name":"Finance","color":"#b0006e"}}' },
    ];
    const res = await run('get-settings');
    expect(res.appSettings).toEqual({ colorBy: 'department' });
    expect(res.printSettings).toEqual({ printScope: 'floor' });
    expect(res.departmentColors).toEqual({ '10': { name: 'Finance', color: '#b0006e' } });
  });

  it('still reads responders and the grid before fp_app_setting is imported, with no settings', async () => {
    fn.missingAppSettingTable = true;
    fn.accessRows = [{ surface: 'map', all_roles: 1, roles: '[]' }];
    await expect(run('get-settings')).resolves.toEqual({
      roles: [],
      responders: [],
      access: { map: { all: true, roles: [] } },
      appSettingsRead: false,
      appSettingsError: 'unavailable',
      appSettings: null,
      printSettings: null,
      departmentColors: null,
    });
  });

  it('fails the read when fp_app_setting fails for another reason — a timeout is not "not imported yet"', async () => {
    fn.appSettingError = new Error('canceling statement due to statement timeout');
    await expect(run('get-settings')).rejects.toThrow(/statement timeout/);
  });

  it('leaves out a stored responder whose employee id is not an org record id, and keeps the rest', async () => {
    fn.roleRows = [{ id: 'firstAider', name: 'First aider', plural: 'First aiders', color: '#00843D', icon: 'cross', shape: 'square', badge_text: null }];
    fn.memberRows = [
      { employee_id: '9', role_id: 'firstAider' },
      { employee_id: 'c1', role_id: 'firstAider' },
    ];
    fn.detailRows = [
      { employee_id: '9', employee_name: 'Omar Al Marri' },
      { employee_id: 'c1', employee_name: 'Demo person' },
    ];
    const res = await run('get-settings');
    expect(res.responders).toEqual([{ employeeId: '9', name: 'Omar Al Marri', roles: ['firstAider'] }]);
    // The legacy read too: an old build sends back what it read just the same.
    expect((await run('get-responders')).responders.map((r: { employeeId: string }) => r.employeeId)).toEqual(['9']);
  });

  it('reads a stored row that is not a JSON object as none, and keeps the rest', async () => {
    fn.appSettingRows = [
      { setting_key: 'settings', value_json: '{not json' },
      { setting_key: 'print', value_json: '["floor"]' },
      { setting_key: 'departmentColors', value_json: '{"10":{"name":"","color":"#123456"}}' },
    ];
    const res = await run('get-settings');
    expect([res.appSettings, res.printSettings]).toEqual([null, null]);
    expect(res.departmentColors).toEqual({ '10': { name: '', color: '#123456' } });
  });

  it('says a capped fp_app_setting answer is too large — no settings served — and still reads roles, responders, the grid, the print settings and the colours', async () => {
    fn.appSettingTruncated = true;
    fn.appSettingRows = [
      { setting_key: 'settings', value_json: '{"colorBy":"department"}' },
      { setting_key: 'print', value_json: '{"printScope":"floor"}' },
      { setting_key: 'departmentColors', value_json: '{"10":{"name":"Finance","color":"#b0006e"}}' },
    ];
    fn.roleRows = [{ id: 'floorWarden', name: 'Floor warden', plural: 'Floor wardens', color: '#C8102E', icon: 'warden', shape: 'circle', badge_text: null }];
    fn.memberRows = [{ employee_id: '12', role_id: 'floorWarden' }];
    fn.detailRows = [{ employee_id: '12', employee_name: 'Sara Haddad' }];
    fn.accessRows = [{ surface: 'settings', all_roles: 0, roles: '["4215"]' }];
    await expect(run('get-settings')).resolves.toEqual({
      roles: [{ id: 'floorWarden', name: 'Floor warden', plural: 'Floor wardens', color: '#C8102E', icon: 'warden', shape: 'circle' }],
      responders: [{ employeeId: '12', name: 'Sara Haddad', roles: ['floorWarden'] }],
      access: { settings: { all: false, roles: ['4215'] } },
      appSettingsRead: false,
      appSettingsError: 'too-large',
      // The settings row is not served at all: left out, it would read as "none stored". The print
      // settings and the colours are read apart from it, so they still come.
      appSettings: null,
      printSettings: { printScope: 'floor' },
      departmentColors: { '10': { name: 'Finance', color: '#b0006e' } },
    });
    expect(fn.queries.filter((q) => /fp_app_setting/.test(q.sql))).toHaveLength(2);
  });

  it('takes the newer of two rows two saves at once left, read oldest first', async () => {
    fn.appSettingRows = [
      { setting_key: 'print', value_json: '{"printScope":"view"}' },
      { setting_key: 'print', value_json: '{"printScope":"floor"}' },
    ];
    expect((await run('get-settings')).printSettings).toEqual({ printScope: 'floor' });
    expect(fn.queries.find((q) => /from fp_app_setting/.test(q.sql))!.sql).toMatch(/order by updated_at$/);
  });
});

/** The settings blob, print settings and department colours: one fp_app_setting row each. */
describe('saving the app settings', () => {
  const settingsWrite = () => {
    const w = writes().find((q) => /insert into fp_app_setting/.test(q.sql))!;
    return { sql: w.sql, key: w.params![0], value: JSON.parse(String(w.params![1])), at: w.params![2], by: w.params![3], seed: w.params![4] };
  };
  const blob = { colorBy: 'department', moduleColors: { 'workstation.free': '#123456' }, printScope: 'floor', printRegisters: { parking: { register: false } }, parkingPrint: { rows: 'vacant' } };

  it("stores the settings but for the print keys, under 'settings', as Facilio names the caller — in one statement that clears the seed", async () => {
    await expect(run('save-app-settings', { settingsJson: JSON.stringify(blob) })).resolves.toEqual({ ok: true, keys: 2 });
    const w = settingsWrite();
    expect(w.key).toBe('settings');
    expect(w.value).toEqual({ colorBy: 'department', moduleColors: { 'workstation.free': '#123456' } });
    expect(w.by).toBe('Test Admin');
    expect(w.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(w.sql).toMatch(/with gone as \(delete from fp_app_setting where setting_key in \(\$1, \$5\)\)\s+insert into fp_app_setting/);
    expect(w.seed).toBe('__seed__');
    expect(writes()).toHaveLength(1);
  });

  it('refuses a caller who may not change settings, and writes nothing', async () => {
    callerRole = 4215;
    await expect(run('save-app-settings', { settingsJson: JSON.stringify(blob) })).rejects.toThrow(/Not saved: only admins and roles given Settings/);
    expect(writes()).toHaveLength(0);
  });

  it('takes it from a role the stored grid gives Settings', async () => {
    callerRole = 4215;
    fn.accessRows = [{ surface: 'settings', all_roles: 0, roles: '["4215"]' }];
    await expect(run('save-app-settings', { settingsJson: '{"colorBy":"status"}' })).resolves.toEqual({ ok: true, keys: 1 });
  });

  describe('with no grid in fp_access, the one the stored settings row carries', () => {
    const settingsRowGranting = (rule: unknown) => [{ setting_key: 'settings', value_json: JSON.stringify({ colorBy: 'status', access: { settings: rule } }) }];

    it('takes it from a role that grid gives Settings — settings and colours alike', async () => {
      callerRole = 4215;
      fn.appSettingRows = settingsRowGranting({ all: false, roles: ['4215'] });
      await expect(run('save-app-settings', { settingsJson: '{"colorBy":"department"}' })).resolves.toEqual({ ok: true, keys: 1 });
      await expect(run('save-department-colors', { colorsJson: '{"10":{"name":"Finance","color":"#b0006e"}}' })).resolves.toEqual({ ok: true, departments: 1 });
    });

    it('refuses a role that grid does not give Settings, and writes nothing', async () => {
      callerRole = 4215;
      fn.appSettingRows = settingsRowGranting({ all: false, roles: ['9999'] });
      await expect(run('save-app-settings', { settingsJson: '{"colorBy":"department"}' })).rejects.toThrow(/only admins and roles given Settings/);
      expect(writes()).toHaveLength(0);
    });

    it('takes it from any role when that grid opens Settings to all', async () => {
      callerRole = 4215;
      fn.appSettingRows = settingsRowGranting({ all: true, roles: [] });
      await expect(run('save-app-settings', { settingsJson: '{"colorBy":"department"}' })).resolves.toEqual({ ok: true, keys: 1 });
    });

    it('is not read once fp_access holds a grid, even one without a Settings rule', async () => {
      callerRole = 4215;
      fn.accessRows = [{ surface: 'map', all_roles: 1, roles: '[]' }];
      fn.appSettingRows = settingsRowGranting({ all: false, roles: ['4215'] });
      await expect(run('save-app-settings', { settingsJson: '{"colorBy":"department"}' })).rejects.toThrow(/only admins and roles given Settings/);
      expect(fn.queries.filter((q) => /from fp_app_setting/.test(q.sql))).toHaveLength(0);
    });
  });

  it('refuses what is not a JSON object, before asking who is calling', async () => {
    await expect(run('save-app-settings', { settingsJson: '[1,2]' })).rejects.toThrow('settingsJson must be a JSON object');
    await expect(run('save-app-settings', { settingsJson: '' })).rejects.toThrow('settingsJson is required');
    expect(identityCalls()).toHaveLength(0);
    expect(fn.queries).toHaveLength(0);
  });

  it('takes a blob with drawn marker icons past the other saves’ cap, and refuses one past 2,000,000 characters', async () => {
    const icon = `data:image/png;base64,${'A'.repeat(199_000)}`;
    const markers = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, name: `Marker ${i}`, color: '#123456', img: icon }));
    await expect(run('save-app-settings', { settingsJson: JSON.stringify({ customMarkers: markers }) })).resolves.toEqual({ ok: true, keys: 1 });
    fn.queries.length = 0;
    fetchMock.mockClear();
    const huge = JSON.stringify({ customMarkers: [{ id: 'm', name: 'M', color: '#123456', img: 'x'.repeat(2_000_000) }] });
    await expect(run('save-app-settings', { settingsJson: huge })).rejects.toThrow(/too large .* at most 2000000/);
    expect(identityCalls()).toHaveLength(0);
    expect(fn.queries).toHaveLength(0);
  });
});

describe('saving the print settings', () => {
  const print = { printScope: 'view', printRegisters: { room: { register: true, cols: ['name', 'id', 'by'], rows: 'assigned', sort: 'emp' }, parking: { register: false } } };

  it("takes them from a caller who is not an admin and was not given Settings — anyone who prints — under 'print'", async () => {
    callerRole = 4215;
    await expect(run('save-print-settings', { printJson: JSON.stringify(print) })).resolves.toEqual({ ok: true });
    const [w] = writes();
    expect(w.params![0]).toBe('print');
    expect(JSON.parse(String(w.params![1]))).toEqual(print);
    expect(w.params![3]).toBe('Test Admin');
    // No grid read: the right to print is not in it.
    expect(fn.queries.filter((q) => /from fp_access/.test(q.sql))).toHaveLength(0);
  });

  it('asks Facilio once — who is calling — and never for the role list', async () => {
    await expect(run('save-print-settings', { printJson: JSON.stringify(print) })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(identityCalls()).toHaveLength(1);
  });

  it('refuses when Facilio cannot say who is calling', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 401, json: async () => null }));
    await expect(run('save-print-settings', { printJson: JSON.stringify(print) })).rejects.toThrow(/could not confirm who is signed in/);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['another setting', { printScope: 'floor', colorBy: 'department' }, /colorBy is not a print setting/],
    ['the old parking key', { parkingPrint: { rows: 'all' } }, /parkingPrint is not a print setting/],
    ['a scope the window does not offer', { printScope: 'everything' }, /printScope must be one of detail, view, floor/],
    ['an unknown register', { printRegisters: { delivery: { register: true } } }, /unknown register delivery/],
    ['a register field the window never sends', { printRegisters: { room: { register: true, script: 'x' } } }, /unknown field script/],
    ['a register that is not on or off', { printRegisters: { room: { register: 'yes' } } }, /register must be true or false/],
    ['a column that is no column key', { printRegisters: { room: { cols: ['name', '<img src=x>'] } } }, /unknown column/],
    ['more columns than a register has', { printRegisters: { room: { cols: Array.from({ length: 61 }, (_, i) => `c${i}`) } } }, /61 columns — at most 60/],
    ['rows the window does not offer', { printRegisters: { room: { rows: 'some' } } }, /rows must be one of/],
    ['a sort the window does not offer', { printRegisters: { room: { sort: 'size' } } }, /sort must be one of/],
  ])('refuses %s, before asking who is calling', async (_what, body, message) => {
    await expect(run('save-print-settings', { printJson: JSON.stringify(body) })).rejects.toThrow(message);
    expect(identityCalls()).toHaveLength(0);
    expect(fn.queries).toHaveLength(0);
  });

  it('refuses a request far larger than four registers', async () => {
    await expect(run('save-print-settings', { printJson: JSON.stringify({ printScope: 'floor', pad: 'x'.repeat(50_000) }) })).rejects.toThrow(/too large/);
    expect(identityCalls()).toHaveLength(0);
  });
});

describe('saving the department colours', () => {
  const scheme = { '10': { name: 'Finance', color: '#b0006e' }, 'name:legal': { name: '', color: '#0D9AA8' }, '30': { color: '#3C229D', extra: 'dropped' } };

  it("stores every department's colour as sent, under 'departmentColors', as Facilio names the caller", async () => {
    await expect(run('save-department-colors', { colorsJson: JSON.stringify(scheme) })).resolves.toEqual({ ok: true, departments: 3 });
    const [w] = writes();
    expect(w.params![0]).toBe('departmentColors');
    expect(JSON.parse(String(w.params![1]))).toEqual({
      '10': { name: 'Finance', color: '#b0006e' },
      'name:legal': { name: '', color: '#0D9AA8' },
      '30': { name: '', color: '#3C229D' },
    });
    expect(w.params![3]).toBe('Test Admin');
  });

  it('refuses a caller who may not change settings, and writes nothing', async () => {
    callerRole = 4215;
    await expect(run('save-department-colors', { colorsJson: JSON.stringify(scheme) })).rejects.toThrow(/only admins/);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['a colour that is not #RRGGBB', { '10': { name: 'Finance', color: 'red' } }, /colour must be #RRGGBB/],
    ['an entry that is not { name, color }', { '10': '#123456' }, /expected \{ name, color \}/],
    ['a name that is not text', { '10': { name: 7, color: '#123456' } }, /name must be text/],
    ['an empty department id', { '': { color: '#123456' } }, /department id must be 1 to 200/],
    ['a list', ['#123456'], /must be a JSON object/],
  ])('refuses %s, before asking who is calling', async (_what, body, message) => {
    await expect(run('save-department-colors', { colorsJson: JSON.stringify(body) })).rejects.toThrow(message);
    expect(identityCalls()).toHaveLength(0);
    expect(fn.queries).toHaveLength(0);
  });

  it('refuses more than 1,000 departments', async () => {
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i + 1), { name: '', color: '#123456' }]));
    await expect(run('save-department-colors', { colorsJson: JSON.stringify(many) })).rejects.toThrow(/1001 departments — at most 1000/);
    expect(identityCalls()).toHaveLength(0);
  });
});

describe('saving the grid, sized', () => {
  it('refuses a surface naming more roles than any org has', async () => {
    const lots = Array.from({ length: 501 }, (_, i) => String(i + 1));
    await expect(run('save-access', grid({ map: { all: false, roles: lots } }))).rejects.toThrow(/at most 500/);
    expect(fn.queries).toHaveLength(0);
  });
});

describe('listing the org roles', () => {
  it("answers with the connection's list trimmed to { id, name, isPrivileged }, run here rather than in the browser", async () => {
    expect(await run('list-roles')).toEqual({
      data: [
        { id: 3873, name: 'CAFM Super Administrator', isPrivileged: true },
        { id: 3874, name: 'CAFM Administrator', isPrivileged: true },
        { id: 4215, name: 'ENEC Executive', isPrivileged: false },
      ],
    });
    expect(fetchMock).toHaveBeenLastCalledWith('https://connections.test/api/v1/connections/facilio-user-management/actions/list-roles/execute', expect.objectContaining({ method: 'POST' }));
  });

  it('folds every spelling of the admin flag into isPrivileged, and drops the rest of the record', async () => {
    const answer = {
      data: [
        { id: 1, name: 'Backend spelling', isPrevileged: true, userCount: 4 },
        { id: 2, name: 'Super admin only', superAdmin: true, userCount: 1 },
        { id: 3, name: 'Plain', isPrivileged: false, isSuperAdmin: false, userCount: 40 },
      ],
    };
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => answer }));
    expect(await run('list-roles')).toEqual({
      data: [
        { id: 1, name: 'Backend spelling', isPrivileged: true },
        { id: 2, name: 'Super admin only', isPrivileged: true },
        { id: 3, name: 'Plain', isPrivileged: false },
      ],
    });
  });
});
