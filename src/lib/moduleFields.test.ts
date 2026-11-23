import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A module's field list is read once per session — but an answer with no field list in it (Facilio
 * refusing for rate, an error body) is not kept as "this module has no fields": the next read asks.
 */

const BUSY = { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' };
const org = vi.hoisted(() => ({ answer: null as unknown, calls: 0 }));

vi.mock('./facilioApi', () => ({
  isFacilioApiConfigured: true,
  customGet: vi.fn(async () => {
    org.calls++;
    return org.answer;
  }),
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

async function fresh() {
  vi.resetModules();
  return import('./moduleFields');
}

beforeEach(() => {
  org.calls = 0;
});

describe("a module's fields", () => {
  it('are read again after a refused read', async () => {
    const { fetchModuleFields } = await fresh();
    org.answer = BUSY;
    expect(await fetchModuleFields('parkingstall')).toBeNull();
    org.answer = { result: { fields: [{ name: 'parkingType', displayName: 'Parking type', dataType: 'enum', enumMap: { 1: 'Covered' } }] } };
    expect(await fetchModuleFields('parkingstall')).toEqual([{ name: 'parkingType', label: 'Parking type', dataType: 'ENUM', options: [{ value: '1', label: 'Covered' }] }]);
    expect(org.calls).toBe(2);
  });

  it('are kept once read — an empty list included', async () => {
    const { fetchModuleFields } = await fresh();
    org.answer = { result: { fields: [] } };
    expect(await fetchModuleFields('lockers')).toEqual([]);
    expect(await fetchModuleFields('lockers')).toEqual([]);
    expect(org.calls).toBe(1);
  });
});
