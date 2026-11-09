import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview, whose pdf.js worker import the test runner can't resolve.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { buildInitialState, reducer } from './reducer';
import { markerLabelInputs, markerSubTexts, unitPlanLabel } from './selectors';
import { markerModel } from '../lib/markerModel';
import { markerStyle } from '../lib/unitStatus';
import { settingsFromState } from '../lib/settingsStore';
import { stallRecordText } from '../lib/facilioApiDataSource';
import { DEFAULT_PARKING_PRINT } from '../lib/types';
import type { Unit } from '../lib/types';
import type { AppState } from './types';

/**
 * What a parking stall says on the plan (Settings › Parking, ENEC 2026-11-09): a text field of the
 * org's own — a short "Stall Number" in place of the long record name — and whether the assigned
 * person shows. Screen and paper read the same rule.
 */

const stall = (record: Record<string, string> = {}): Unit =>
  ({ id: '1576962', type: 'parking', label: 'ABU/EHQ/PKG/HQ-622', geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan: 'parking', room: null, record }) as Unit;
const desk = { id: 'd1', type: 'workstation', label: 'N-047', geom: { kind: 'point', x: 0.2, y: 0.5 }, floor: 'f1', plan: 'workstation', room: null, record: { stall_number_parkingstall: 'x' } } as Unit;

const floor = (over: Partial<AppState> = {}): AppState => ({
  ...buildInitialState(),
  floorId: 'f1',
  mode: 'assign',
  units: [stall({ stall_number_parkingstall: '622' }), desk],
  assignments: { '1576962': 'e1' },
  employees: [{ id: 'e1', name: 'Omar Al Marri', department: 'Finance' }],
  ...over,
});
const byNumber = { field: 'stall_number_parkingstall', showHolder: true };

describe('a parking stall on the plan', () => {
  it('reads its name until Settings › Parking picks another field', () => {
    const s = floor();
    expect(s.parkingLabel).toEqual({ field: 'name', showHolder: true });
    expect(unitPlanLabel(s, s.units[0])).toBe('ABU/EHQ/PKG/HQ-622');
  });

  it('reads the picked field, and its name where that field is empty', () => {
    const s = floor({ parkingLabel: byNumber });
    expect(unitPlanLabel(s, s.units[0])).toBe('622');
    expect(unitPlanLabel(s, stall({}))).toBe('ABU/EHQ/PKG/HQ-622');
    expect(markerLabelInputs(s, s.units).find((l) => l.id === '1576962')?.name).toBe('622');
    // The tooltip keeps the record name the card no longer shows.
    expect(markerModel(s, s.units[0]).title.startsWith('622 (ABU/EHQ/PKG/HQ-622)')).toBe(true);
  });

  it('never relabels anything but parking', () => {
    expect(unitPlanLabel(floor({ parkingLabel: byNumber }), desk)).toBe('N-047');
  });

  it('drops the assigned person, from the card and from the chip, when the setting says so', () => {
    const shown = floor({ parkingLabel: byNumber });
    expect(markerSubTexts(shown, shown.units[0]).holder).toBe('Omar Al Marri');
    expect(markerStyle(shown, shown.units[0]).occText).toBe('OA');
    const hidden = floor({ parkingLabel: { ...byNumber, showHolder: false } });
    expect(markerSubTexts(hidden, hidden.units[0])).toEqual({ holder: null, dept: null });
    const chip = markerStyle(hidden, hidden.units[0]);
    expect(chip.occText).toBeNull();
    expect(chip.icon).toBe('parking'); // still blue: it is still taken
  });

  it('is kept for everyone in the settings, and read back over the defaults', () => {
    const s = reducer(floor(), { type: 'SET_PARKING_LABEL', value: byNumber });
    expect(settingsFromState(s).parkingLabel).toEqual(byNumber);
    const applied = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { parkingLabel: { field: 'qrVal' } as never } });
    expect(applied.parkingLabel).toEqual({ field: 'qrVal', showHolder: true });
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

describe("a stall record's values", () => {
  it('are kept as text: strings, numbers, and a lookup or state by its name, without the plumbing', () => {
    const rec = stallRecordText({
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
});
