import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview, whose pdf.js worker import the test runner can't resolve.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { buildInitialState, reducer } from './reducer';
import { markerLabelInputs, markerSubTexts, roomLabelInputs, unitPlanLabel } from './selectors';
import { markerModel } from '../lib/markerModel';
import { markerStyle } from '../lib/unitStatus';
import { settingsFromState } from '../lib/settingsStore';
import { recordText } from '../lib/facilioApiDataSource';
import { fieldTitle } from '../hooks/useRecordFields';
import { DEFAULT_PARKING_PRINT, DEFAULT_PLAN_LABEL, DEFAULT_PLAN_LABELS } from '../lib/types';
import type { PlanLabels, Unit } from '../lib/types';
import type { AppState } from './types';

/**
 * What a desk, a parking stall or a room says on the plan (Settings › Desks / Parking / Rooms ›
 * Label on the plan; ENEC, 2026-11-09 and -12): a text field of its own record — a desk's Desk
 * Code, a short "Stall Number", a room's Code — in place of the long record name, and, for desks
 * and stalls, whether the assigned person shows. Screen and paper read the same rule.
 */

const stall = (record: Record<string, string> = {}): Unit =>
  ({ id: '1576962', type: 'parking', label: 'ABU/EHQ/PKG/HQ-622', geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan: 'parking', room: null, record }) as Unit;
const desk = (record: Record<string, string> = {}): Unit =>
  ({ id: 'd1', type: 'workstation', label: 'ABU/EHQ/BKB/3F/N-047', geom: { kind: 'point', x: 0.2, y: 0.5 }, floor: 'f1', plan: 'workstation', room: null, record }) as Unit;
const room = (record: Record<string, string> = {}): Unit =>
  ({ id: 'r1', type: 'room', label: 'HQ-BKB-3F-Meeting Room 2', geom: { kind: 'poly', pts: [[0.6, 0.1], [0.8, 0.1], [0.8, 0.3], [0.6, 0.3]] }, floor: 'f1', plan: 'workstation', room: null, record }) as Unit;
const locker = { id: 'l1', type: 'locker', label: 'L-04', geom: { kind: 'point', x: 0.9, y: 0.5 }, floor: 'f1', plan: 'locker', room: null, record: { code_space: 'X' } } as Unit;

const floor = (labels: Partial<PlanLabels> = {}, over: Partial<AppState> = {}): AppState => ({
  ...buildInitialState(),
  floorId: 'f1',
  mode: 'assign',
  units: [stall({ stall_number_parkingstall: '622' }), desk({ deskCode: 'N-047' }), room({ code_space: 'MR-2' }), locker],
  assignments: { '1576962': 'e1', d1: 'e2' },
  employees: [
    { id: 'e1', name: 'Omar Al Marri', department: 'Finance' },
    { id: 'e2', name: 'Priya Nair', department: 'Engineering' },
  ],
  planLabels: { ...DEFAULT_PLAN_LABELS, ...labels },
  ...over,
});
const by = (field: string, showHolder = true) => ({ field, showHolder });

describe('the plan label of a desk, a stall or a room', () => {
  it('is the record name until Label on the plan picks another field', () => {
    const s = floor();
    expect(s.planLabels).toEqual({ workstation: DEFAULT_PLAN_LABEL, parking: DEFAULT_PLAN_LABEL, room: DEFAULT_PLAN_LABEL });
    expect(s.units.map((u) => unitPlanLabel(s, u))).toEqual(['ABU/EHQ/PKG/HQ-622', 'ABU/EHQ/BKB/3F/N-047', 'HQ-BKB-3F-Meeting Room 2', 'L-04']);
  });

  it('reads the picked field of each type, and the name where that field is empty', () => {
    const s = floor({ parking: by('stall_number_parkingstall'), workstation: by('deskCode'), room: by('code_space') });
    expect(s.units.map((u) => unitPlanLabel(s, u))).toEqual(['622', 'N-047', 'MR-2', 'L-04']); // a locker keeps its name
    expect(unitPlanLabel(s, desk({}))).toBe('ABU/EHQ/BKB/3F/N-047');
    expect(unitPlanLabel(s, room({}))).toBe('HQ-BKB-3F-Meeting Room 2');
  });

  it('labels the markers and the room outlines on the plan alike, and keeps the record name in the tooltip', () => {
    const s = floor({ workstation: by('deskCode'), room: by('code_space') });
    expect(markerLabelInputs(s, s.units).find((l) => l.id === 'd1')?.name).toBe('N-047');
    expect(roomLabelInputs(s, [s.units[2]])[0].name).toBe('MR-2');
    expect(markerModel(s, s.units[1]).title.startsWith('N-047 (ABU/EHQ/BKB/3F/N-047)')).toBe(true);
  });

  it('drops the assigned person, from the card and from the chip, for the type whose setting says so', () => {
    const s = floor({ workstation: by('deskCode', false) });
    const deskUnit = s.units[1];
    expect(markerSubTexts(s, deskUnit)).toEqual({ holder: null, dept: null });
    expect(markerStyle(s, deskUnit).occText).toBeNull();
    expect(markerStyle(s, deskUnit).icon).toBe('workstation');
    // The stalls' own setting still shows theirs.
    expect(markerSubTexts(s, s.units[0]).holder).toBe('Omar Al Marri');
    expect(markerStyle(s, s.units[0]).occText).toBe('OA');
  });

  it('is kept for everyone in the settings, and read back over the defaults', () => {
    const s = reducer(floor(), { type: 'SET_PLAN_LABEL', kind: 'workstation', value: by('deskCode') });
    expect(settingsFromState(s).planLabels?.workstation).toEqual(by('deskCode'));
    const applied = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { planLabels: { room: { field: 'code_space' } as never } } });
    expect(applied.planLabels.room).toEqual({ field: 'code_space', showHolder: true });
    expect(applied.planLabels.workstation).toEqual(DEFAULT_PLAN_LABEL);
  });

  it('reads the parking label v68–v69 stored on its own, and keeps it only under planLabels from then on', () => {
    const applied = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { parkingLabel: by('stall_number_parkingstall', false) } });
    expect(applied.planLabels.parking).toEqual(by('stall_number_parkingstall', false));
    expect(settingsFromState(applied).planLabels?.parking).toEqual(by('stall_number_parkingstall', false));
    expect(settingsFromState(applied)).not.toHaveProperty('parkingLabel');
  });
});

describe('the parking register choices', () => {
  const mine = { ...DEFAULT_PARKING_PRINT, cols: ['emp', 'mobile'], sort: 'dept' as const };

  it('are kept for everyone who prints parking', () => {
    const s = reducer(floor(), { type: 'SET_PARKING_PRINT', value: mine });
    expect(s.parkingPrint).toEqual(mine);
    expect(settingsFromState(s).parkingPrint).toEqual(mine);
  });

  it('are read back over the defaults', () => {
    expect(reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { parkingPrint: mine } }).parkingPrint).toEqual(mine);
    expect(reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { parkingPrint: { rows: 'vacant' } as never } }).parkingPrint).toEqual({ ...DEFAULT_PARKING_PRINT, rows: 'vacant' });
  });
});

describe("a record's values", () => {
  it('are kept as text: strings, numbers, and a lookup or state by its name, without the plumbing', () => {
    const rec = recordText({
      id: 1576962,
      name: 'ABU/EHQ/PKG/HQ-622',
      qrVal: 'ABU/EHQ/PKG/HQ-622',
      stall_number_parkingstall: '622',
      parkingMode: 2,
      moduleState: { id: 9, status: 'occupied', displayName: 'Occupied' },
      occupied_time_parkingstall: 1767225600000,
      siteId: 783657,
      sysCreatedTime: 1767225600000,
      site: { id: 783657 },
      description: '',
      localId: -1,
    });
    expect(rec).toEqual({
      id: '1576962',
      name: 'ABU/EHQ/PKG/HQ-622',
      qrVal: 'ABU/EHQ/PKG/HQ-622',
      stall_number_parkingstall: '622',
      parkingMode: '2',
      moduleState: 'Occupied',
      occupied_time_parkingstall: '1767225600000',
    });
  });

  it('are named as the org names them, or tidily from their API name', () => {
    expect(fieldTitle('deskCode')).toBe('Desk Code');
    expect(fieldTitle('code_space')).toBe('Code');
    expect(fieldTitle('stall_number_parkingstall')).toBe('Stall Number');
    expect(fieldTitle('reservation_type_desks')).toBe('Reservation Type');
    expect(fieldTitle('anything', [{ name: 'anything', label: 'What ENEC calls it' }])).toBe('What ENEC calls it');
  });
});
