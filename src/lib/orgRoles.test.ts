import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading the org's roles for the access grid.
 *
 * The connector goes through the platform rather than the Facilio page, so it answers however the
 * app was opened; the V3 route needs the host bridge, which was exactly what was missing when the
 * grid came up with "could not be loaded". The fixture is ENEC's real answer, trimmed.
 */

// What `facilio-user-management.list-roles` returned for ENEC CAFM.
const ENEC_ROLES = {
  data: [
    { id: 3873, name: 'CAFM Super Administrator', isSuperAdmin: true, isPrivileged: true, userCount: 1 },
    { id: 3874, name: 'CAFM Administrator', isSuperAdmin: false, isPrivileged: true, userCount: 11 },
    { id: 4215, name: 'ENEC Executive', isSuperAdmin: false, isPrivileged: false, userCount: 11 },
  ],
};

async function load({ isVibeApp, apiConfigured, connector, v3 }: { isVibeApp: boolean; apiConfigured: boolean; connector: () => Promise<unknown>; v3: () => Promise<unknown> }) {
  vi.resetModules();
  const executeAction = vi.fn(connector);
  const customGet = vi.fn(v3);
  vi.doMock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
  vi.doMock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
  vi.doMock('./vibe', () => ({ isVibeApp, vibe: { executeAction }, CMMS_CONNECTION: 'facilio-cmms' }));
  vi.doMock('./facilioApi', async () => {
    const real = await vi.importActual<typeof import('./facilioApi')>('./facilioApi');
    return { ...real, isFacilioApiConfigured: apiConfigured, customGet };
  });
  const { fetchOrgRoles } = await import('./facilioApiDataSource');
  return { fetchOrgRoles, executeAction, customGet };
}

afterEach(() => {
  for (const m of ['./pdfPreview', './cadPreview', './vibe', './facilioApi']) vi.doUnmock(m);
});

describe("the org's roles", () => {
  it('come from the connector, which works however the app was opened', async () => {
    const { fetchOrgRoles, executeAction, customGet } = await load({
      isVibeApp: true,
      apiConfigured: false, // no host bridge — the case that left the grid empty
      connector: async () => ENEC_ROLES,
      v3: async () => null,
    });
    const roles = await fetchOrgRoles();
    expect(executeAction).toHaveBeenCalledWith('facilio-user-management', 'list-roles', {});
    expect(customGet).not.toHaveBeenCalled();
    expect(roles.map((r) => r.name)).toEqual(['CAFM Administrator', 'CAFM Super Administrator', 'ENEC Executive']);
  });

  it('marks BOTH admin roles — CAFM Administrator carries only the privileged flag', async () => {
    const { fetchOrgRoles } = await load({ isVibeApp: true, apiConfigured: false, connector: async () => ENEC_ROLES, v3: async () => null });
    const byName = Object.fromEntries((await fetchOrgRoles()).map((r) => [r.name, r.isAdmin]));
    expect(byName['CAFM Super Administrator']).toBe(true);
    expect(byName['CAFM Administrator']).toBe(true);
    expect(byName['ENEC Executive']).toBe(false);
  });

  it('read the backend spelling too, when they come from V3 instead', async () => {
    const { fetchOrgRoles } = await load({
      isVibeApp: true,
      apiConfigured: true,
      connector: async () => ({ data: [] }),
      v3: async () => ({ result: { Roles: [{ roleId: 7, name: 'Workplace Admin', isPrevileged: true }] } }),
    });
    expect(await fetchOrgRoles()).toEqual([{ id: '7', name: 'Workplace Admin', isAdmin: true }]);
  });

  it('fall back to V3 when the connector fails', async () => {
    const { fetchOrgRoles, customGet } = await load({
      isVibeApp: true,
      apiConfigured: true,
      connector: async () => {
        throw new Error('connection not active');
      },
      v3: async () => ({ Roles: [{ roleId: 9, name: 'Reception Lead' }] }),
    });
    expect((await fetchOrgRoles()).map((r) => r.name)).toEqual(['Reception Lead']);
    expect(customGet).toHaveBeenCalledWith('v2/setup/getRoles', undefined);
  });

  it('never count a role id of 0 as a role', async () => {
    const { fetchOrgRoles } = await load({
      isVibeApp: true,
      apiConfigured: false,
      connector: async () => ({ data: [{ id: 0, name: 'Nobody' }, { id: 12, name: 'Somebody' }] }),
      v3: async () => null,
    });
    expect((await fetchOrgRoles()).map((r) => r.id)).toEqual(['12']);
  });
});
