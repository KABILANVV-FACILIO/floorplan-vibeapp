import { describe, expect, it, vi } from 'vitest';

/**
 * floorplanApi is not deployed (featureFlags.FLOORPLAN_API_DEPLOYED), so nothing may be sent to it:
 * the stored-floorplan list, the settings read and the department colours used to call it on every
 * page open, each failing, each a round trip for nothing.
 */

const executeFunction = vi.fn(async () => {
  throw new Error('function not found');
});
vi.mock('./vibe', () => ({ isVibeApp: true, FLOORPLAN_FN: 'floorplanApi', vibe: { executeFunction } }));

const db = await import('./vibeDbDataSource');

describe('the undeployed floorplanApi function', () => {
  it('is never called — every read answers "unavailable" at once', async () => {
    expect(await db.fetchVibeSettings()).toBeNull();
    expect(await db.fetchDepartmentColors()).toEqual([]);
    expect(await db.listVibeFloorplanFloors()).toEqual([]);
    expect(await db.storeVibeSettings({})).toBe(false);
    expect(executeFunction).not.toHaveBeenCalled();
  });
});
