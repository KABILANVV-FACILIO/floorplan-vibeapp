import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from '../lib/types';

/**
 * The explicit-save chokepoint decides what the user is told: "Changes saved", "Saved — N room
 * outlines not written…", or "Could not save changes". These pin the room-outline half of that
 * rule against stubbed marker/zone syncs: nothing written at all throws, per-room skips on a save
 * that otherwise went through are reported (not thrown), and the zone sync runs — with the saved
 * snapshot as its baseline — even when the marker result is about to throw.
 */

const sync = vi.hoisted(() => ({
  markers: { plansSynced: 1, skipped: [] as string[] },
  zones: { plansSynced: 1, created: 0, updated: 0, deleted: 0, skipped: [] as string[], plansSkipped: 0, roomsNotWritten: [] as string[] },
}));

vi.mock('../lib/dataSource', () => ({ dataSource: { saveUnits: vi.fn(async () => {}) } }));
vi.mock('../lib/facilioApi', () => ({ isFacilioApiConfigured: true }));
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('../lib/facilioApiDataSource', async () => {
  // The REAL predicate — persistUnits shares it with the zone sync rather than keeping a copy.
  const actual = await vi.importActual<typeof import('../lib/facilioApiDataSource')>('../lib/facilioApiDataSource');
  return {
    isOrgZoneUnit: actual.isOrgZoneUnit,
    saveFloorplanMarkers: vi.fn(async () => sync.markers),
    saveFloorplanZones: vi.fn(async () => sync.zones),
  };
});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { persistUnits, savedNotice } = await import('./persistUnits');
const { saveFloorplanZones } = await import('../lib/facilioApiDataSource');

const SQUARE: [number, number][] = [
  [0.1, 0.1],
  [0.3, 0.1],
  [0.3, 0.3],
];
const orgRoom: Unit = { id: '819849', type: 'room', label: 'Meeting Room 2', room: null, geom: { kind: 'poly', pts: SQUARE }, floor: '5150', plan: 'workstation' };
const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: '5150', plan: 'workstation' };

beforeEach(() => {
  sync.markers = { plansSynced: 1, skipped: [] };
  sync.zones = { plansSynced: 1, created: 0, updated: 0, deleted: 0, skipped: [], plansSkipped: 0, roomsNotWritten: [] };
  vi.mocked(saveFloorplanZones).mockClear();
});

describe('persistUnits and room outlines', () => {
  it('throws when an org room is on the floor and no plan took any outline', async () => {
    sync.zones = { ...sync.zones, plansSynced: 0, plansSkipped: 1, skipped: ['workstation: plan #26 has no georeference — room outlines not written'], roomsNotWritten: ['Meeting Room 2'] };
    await expect(persistUnits('5150', [orgRoom], [])).rejects.toThrow(/room outlines not written/);
  });

  it('reports per-room skips on a save that went through, instead of throwing', async () => {
    sync.zones = { ...sync.zones, plansSynced: 1, skipped: ['workstation: "Meeting Room 2" (#819849): its outline on this plan was drawn in Facilio — left unchanged'], roomsNotWritten: ['Meeting Room 2'] };
    const outcome = await persistUnits('5150', [orgRoom], []);
    expect(outcome.roomsNotWritten).toEqual(['Meeting Room 2']);
    expect(savedNotice(outcome)).toBe('Saved — 1 room outline not written to the org: Meeting Room 2');
    expect(savedNotice({ roomsNotWritten: [] })).toBe('Changes saved');
  });

  it('still runs the zone sync, with the saved snapshot, when the marker result is about to throw', async () => {
    sync.markers = { plansSynced: 0, skipped: ['workstation: no georeference'] };
    const baseline = [orgRoom, desk];
    await expect(persistUnits('5150', [desk], baseline)).rejects.toThrow(/markers not written/);
    expect(saveFloorplanZones).toHaveBeenCalledWith('5150', [desk], baseline);
  });

  it('reports, not throws, when every room was skipped per room and no plan failed', async () => {
    sync.zones = { ...sync.zones, plansSynced: 0, skipped: ['"New room": #4242424 is not a room this floor loaded from the org'], roomsNotWritten: ['New room'] };
    await expect(persistUnits('5150', [{ ...orgRoom, id: '4242424', label: 'New room' }], [])).resolves.toEqual({ roomsNotWritten: ['New room'] });
  });

  it('does not treat a room id of 0 as an org room', async () => {
    sync.zones = { ...sync.zones, plansSynced: 0, plansSkipped: 1, skipped: ['x'] };
    await expect(persistUnits('5150', [{ ...orgRoom, id: '0' }], [])).resolves.toEqual({ roomsNotWritten: [] });
  });
});
