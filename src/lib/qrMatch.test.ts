import { describe, expect, it } from 'vitest';
import { matchSpaceCode, spaceCodeOf } from './qrMatch';
import type { Unit } from './types';

function desk(id: string, label: string): Unit {
  return { id, type: 'workstation', label, room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan: 'workstation' } as Unit;
}

const floor = [desk('101', 'WS-10'), desk('102', 'WS-107'), desk('103', 'Hot desk 3')];

describe('matchSpaceCode', () => {
  it('finds the space whose name the code is, ignoring case and separators', () => {
    expect(matchSpaceCode(floor, 'WS-107')).toEqual({ unit: floor[1] });
    expect(matchSpaceCode(floor, 'ws 107')).toEqual({ unit: floor[1] });
    expect(matchSpaceCode(floor, 'hot_desk-3')).toEqual({ unit: floor[2] });
  });

  it('never takes a space whose name merely contains, or is contained in, the code', () => {
    // "WS-107" used to open a booking for "WS-10".
    expect(matchSpaceCode([desk('101', 'WS-10')], 'WS-107')).toEqual({ unit: null, reason: 'none' });
    expect(matchSpaceCode([desk('102', 'WS-107')], 'WS-10')).toEqual({ unit: null, reason: 'none' });
  });

  it('never matches a space with no name to every code', () => {
    expect(matchSpaceCode([desk('9', ''), ...floor], 'XYZ-1')).toEqual({ unit: null, reason: 'none' });
    expect(matchSpaceCode([desk('9', '')], 'WS-10')).toEqual({ unit: null, reason: 'none' });
  });

  it('falls back to the record id when no name matches', () => {
    expect(matchSpaceCode(floor, '103')).toEqual({ unit: floor[2] });
  });

  it('picks neither when two spaces share the code', () => {
    expect(matchSpaceCode([desk('1', 'WS-07'), desk('2', 'WS 07')], 'WS-07')).toEqual({ unit: null, reason: 'ambiguous' });
  });

  it('reads the code out of a URL', () => {
    expect(matchSpaceCode(floor, 'https://example.com/book?space=WS-107')).toEqual({ unit: floor[1] });
    expect(matchSpaceCode(floor, 'https://example.com/spaces/WS-10')).toEqual({ unit: floor[0] });
  });

  it('finds nothing for an empty code', () => {
    expect(matchSpaceCode(floor, '   ')).toEqual({ unit: null, reason: 'none' });
  });
});

describe('spaceCodeOf', () => {
  it('prefers the qr, space and unit parameters, then the last path segment', () => {
    expect(spaceCodeOf('https://x.test/a?qr=A1&space=B2')).toBe('A1');
    expect(spaceCodeOf('https://x.test/a?unit=C3')).toBe('C3');
    expect(spaceCodeOf('https://x.test/floors/7/WS-09')).toBe('WS-09');
    expect(spaceCodeOf(' WS-09 ')).toBe('WS-09');
  });
});
