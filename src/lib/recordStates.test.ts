import { describe, expect, it } from 'vitest';
import { isReserved, isTemporarilyVacant, noteRecordStates, recordStateKey, takeRecordStates } from './recordStates';

describe('recordStateKey', () => {
  it("keys a state by its status, which the org can't rename, over its display name", () => {
    expect(recordStateKey({ id: 7, status: 'temporarilyvacant', displayName: 'Away for now' })).toBe('temporarilyvacant');
    expect(recordStateKey({ id: 7, displayName: 'Temporarily Vacant' })).toBe('temporarilyvacant');
    expect(recordStateKey('Reserved')).toBe('reserved');
    expect(recordStateKey({ id: 7 })).toBeNull();
    expect(recordStateKey(null)).toBeNull();
  });

  it('tells the states the card splits by', () => {
    expect(isTemporarilyVacant('temporarilyvacant')).toBe(true);
    expect(isTemporarilyVacant('vacant')).toBe(false);
    expect(isReserved('reserved')).toBe(true);
    expect(isReserved('occupied')).toBe(false);
    expect(isReserved(undefined)).toBe(false);
  });
});

describe('noteRecordStates / takeRecordStates', () => {
  it('gathers the pages of a floor until they are taken, then starts again', () => {
    noteRecordStates('f1', [{ id: 1, moduleState: { status: 'vacant' } }, { id: 2, moduleState: { status: 'temporarilyvacant' } }, { id: 3 }]);
    noteRecordStates('f1', [{ id: 4, moduleState: { displayName: 'Reserved' } }]);
    noteRecordStates('f2', [{ id: 9, moduleState: { status: 'occupied' } }]);
    expect(takeRecordStates('f1')).toEqual({ '1': 'vacant', '2': 'temporarilyvacant', '4': 'reserved' });
    expect(takeRecordStates('f1')).toEqual({});
    expect(takeRecordStates('f2')).toEqual({ '9': 'occupied' });
  });

  it("reads a local seed unit's `state` the same way", () => {
    noteRecordStates('demo', [{ id: 'ws1', state: 'Temporarily Vacant' }]);
    expect(takeRecordStates('demo')).toEqual({ ws1: 'temporarilyvacant' });
  });
});

describe('clearRecordStates', () => {
  it("forgets a floor's untaken states, and only that floor's", async () => {
    const { clearRecordStates, noteRecordStates, takeRecordStates } = await import('./recordStates');
    noteRecordStates('f1', [{ id: 1, moduleState: { status: 'reserved' } }]);
    noteRecordStates('f2', [{ id: 2, moduleState: { status: 'occupied' } }]);
    clearRecordStates('f1');
    expect(takeRecordStates('f1')).toEqual({});
    expect(takeRecordStates('f2')).toEqual({ '2': 'occupied' });
  });
});
