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
}));

vi.mock('@facilio/studio-functions', () => ({
  default: class {
    addHandler(h: Handler) {
      fn.handlers.set(h.name, h);
    }
    execute() {}
  },
  StudioDatabase: class {
    query(sql: string, params?: unknown[]) {
      fn.queries.push({ sql, params });
      if (/^\s*select surface, all_roles, roles from fp_access/.test(sql)) return { rows: fn.accessRows };
      return { rows: [] };
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
const fetchMock = vi.fn(async (url: string) => {
  const answer = url.includes('get-current-user-profile')
    ? { data: { user: { id: 1, name: 'Test Admin', role: { id: callerRole } }, app: { linkName: 'maintenance' } } }
    : url.includes('list-roles')
      ? { data: ROLES }
      : null;
  return { ok: !!answer, status: answer ? 200 : 404, json: async () => answer };
});
vi.stubGlobal('fetch', fetchMock);
(process as unknown as { system: Record<string, string> }).system = { CONNECTIONS_URL: 'https://connections.test' };

await import('./code');
const run = (name: string, args: Record<string, unknown> = {}) => fn.handlers.get(name)!.execute(args);
const writes = () => fn.queries.filter((q) => /insert into/.test(q.sql));
const grid = (g: Record<string, { all: boolean; roles: string[] }>) => ({ accessJson: JSON.stringify(g) });

beforeEach(() => {
  fn.queries.length = 0;
  fn.accessRows = [];
  callerRole = 3874;
});

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
});

describe('saving responders and their roles', () => {
  it('refuses a caller who may not change settings', async () => {
    callerRole = 4215;
    await expect(run('save-roles', { rolesJson: JSON.stringify([{ id: 'fa', name: 'First aider', color: '#16A34A', icon: 'cross', shape: 'circle' }]) })).rejects.toThrow(/only admins/);
    await expect(run('save-responders', { respondersJson: JSON.stringify([{ employeeId: '9', name: 'Omar Al Marri', roles: ['fa'] }]) })).rejects.toThrow(/only admins/);
    expect(writes()).toHaveLength(0);
  });

  it('refuses a badge it cannot draw before asking who is calling', async () => {
    await expect(run('save-roles', { rolesJson: JSON.stringify([{ id: 'fa', name: 'First aider', color: 'green', icon: 'cross', shape: 'circle' }]) })).rejects.toThrow('colour must be #RRGGBB');
    expect(writes()).toHaveLength(0);
  });
});

describe('listing the org roles', () => {
  it("answers with the connection's list, run here rather than in the browser", async () => {
    expect(await run('list-roles')).toEqual({ data: ROLES });
    expect(fetchMock).toHaveBeenLastCalledWith('https://connections.test/api/v1/connections/facilio-user-management/actions/list-roles/execute', expect.objectContaining({ method: 'POST' }));
  });
});
