import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from '../lib/types';

/**
 * Save with no host to write through.
 *
 * Desk positions reach Facilio only through the host bridge, which exists when the app is opened
 * inside Facilio or the mobile app. A preview link opened in its own tab has none — and Save used
 * to write the browser copy, return, and say "Changes saved". The desk was then gone on reload,
 * because the floor is read back from the org, which never received it.
 *
 * Both halves are pinned: the deployed app must refuse to call that a save, and plain local dev
 * (no backend at all, where the browser copy IS the save) must keep working without an error.
 */

const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: '5150', plan: 'workstation' };

async function load(isVibeApp: boolean) {
  vi.resetModules();
  const saveUnits = vi.fn(async () => {});
  const saveFloorplanMarkers = vi.fn(async () => ({ plansSynced: 1, skipped: [], unitsNotWritten: [], retryIds: [] }));
  vi.doMock('../lib/facilioApi', () => ({ isFacilioApiConfigured: false }));
  vi.doMock('../lib/vibe', () => ({ isVibeApp }));
  vi.doMock('../lib/dataSource', () => ({ dataSource: { saveUnits } }));
  vi.doMock('../lib/facilioApiDataSource', () => ({
    isOrgZoneUnit: () => false,
    roomOutlineChanges: () => [],
    saveFloorplanMarkers,
    saveFloorplanZones: vi.fn(),
  }));
  const mod = await import('./persistUnits');
  return { ...mod, saveUnits, saveFloorplanMarkers };
}

afterEach(() => {
  vi.doUnmock('../lib/facilioApi');
  vi.doUnmock('../lib/vibe');
  vi.doUnmock('../lib/dataSource');
  vi.doUnmock('../lib/facilioApiDataSource');
});

describe('Save with no Facilio host', () => {
  it('in the deployed app, keeps the browser copy but refuses to call it saved', async () => {
    const { persistUnits, NotSavedToOrgError, saveUnits, saveFloorplanMarkers } = await load(true);

    await expect(persistUnits('5150', [desk])).rejects.toBeInstanceOf(NotSavedToOrgError);
    // The edit is not lost: the browser copy was written before the refusal.
    expect(saveUnits).toHaveBeenCalledWith('5150', [desk]);
    // And nothing pretended to reach the org.
    expect(saveFloorplanMarkers).not.toHaveBeenCalled();
  });

  it('says where the changes went and how to save them properly', async () => {
    const { NotSavedToOrgError } = await load(true);
    const message = new NotSavedToOrgError().message;
    expect(message).toMatch(/this browser only/i);
    expect(message).toMatch(/inside Facilio/i);
  });

  it('in plain local dev, where the browser copy is the save, completes without an error', async () => {
    const { persistUnits, saveUnits } = await load(false);

    await expect(persistUnits('5150', [desk])).resolves.toEqual({ roomsNotWritten: [], unitsNotWritten: [], toRetry: [] });
    expect(saveUnits).toHaveBeenCalledWith('5150', [desk]);
  });
});
