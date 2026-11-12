import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The demo seed (src/data/*.json) is for the dev server only. Every `vite build` — what is deployed
 * to preview and production — has import.meta.env.DEV false, and must never show a made-up site,
 * person, desk or booking, even when the org's own list comes back empty or fails.
 */

vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  localStorage.clear();
});

async function localTier(dev: boolean) {
  vi.stubEnv('DEV', dev);
  vi.resetModules();
  const mod = await import('./dataSource');
  return mod;
}

describe('the demo seed', () => {
  it('is served under the dev server', async () => {
    const { LocalJsonDataSource } = await localTier(true);
    const local = new LocalJsonDataSource();
    expect((await local.getPortfolio()).length).toBeGreaterThan(0);
    expect((await local.getEmployees()).length).toBeGreaterThan(0);
    expect((await local.getUnits('hqA3')).length).toBeGreaterThan(0);
  });

  it('is never served by a deployed build', async () => {
    const { LocalJsonDataSource } = await localTier(false);
    const local = new LocalJsonDataSource();
    expect(await local.getPortfolio()).toEqual([]);
    expect(await local.getEmployees()).toEqual([]);
    expect(await local.getAssets()).toEqual([]);
    expect(await local.getUnits('hqA3')).toEqual([]);
    expect(await local.getAssignments('hqA3')).toEqual({});
    expect(await local.getBookings('hqA3', '2026-10-22')).toEqual([]);
  });

  it('leaves an empty org directory empty in a deployed build, rather than filling it with demo people', async () => {
    const { CompositeDataSource, LocalJsonDataSource } = await localTier(false);
    const emptyOrg = { name: 'org', getEmployees: async () => [] } as never;
    // Every tier came back empty, so the read fails — the caller shows no one, not the seed.
    await expect(new CompositeDataSource([emptyOrg, new LocalJsonDataSource()]).getEmployees()).rejects.toThrow();
  });
});
