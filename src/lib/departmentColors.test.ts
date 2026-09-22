import { describe, expect, it } from 'vitest';
import { departmentColor, departmentColorMap, departmentKey, departmentsIn, DEPARTMENT_PALETTE } from './departmentColors';

/**
 * Colouring by department only helps if a department looks the same everywhere — the same colour
 * on every floor, in the legend, in Settings, and after somebody renames it in Facilio. Colours
 * are therefore keyed by the department's RECORD ID, which is what these pin.
 */

describe('a department always looks like itself', () => {
  it('gives the same colour to the same id, every time', () => {
    expect(departmentColor('42')).toBe(departmentColor('42'));
  });

  it('is keyed by the id, so a rename in Facilio cannot cost it its colour', () => {
    const ids = ['42', '43'];
    const before = departmentColor('42', {}, ids);
    // Same record, new name — nothing about the colour's key changed.
    expect(departmentColor('42', {}, ids)).toBe(before);
  });

  it('answers with a colour before anyone has configured one', () => {
    expect(DEPARTMENT_PALETTE).toContain(departmentColor('42'));
  });

  it('lets a configured colour win, and only for that department', () => {
    const overrides = { '42': '#b0006e' };
    expect(departmentColor('42', overrides)).toBe('#b0006e');
    expect(departmentColor('43', overrides)).not.toBe('#b0006e');
  });

  it('never gives two departments on the same plan the same colour', () => {
    // Hashing each id independently drew two of four departments the same green on the first real
    // floor this met — with a ten-colour wheel, four collide about half the time.
    const ids = ['11', '12', '13', '14'];
    const colours = ids.map((id) => departmentColor(id, {}, ids));
    expect(new Set(colours).size).toBe(ids.length);
  });

  it('keeps every department distinct right up to the size of the wheel', () => {
    const ids = Array.from({ length: DEPARTMENT_PALETTE.length }, (_, i) => `d${i}`);
    const colours = ids.map((id) => departmentColor(id, {}, ids));
    expect(new Set(colours).size).toBe(DEPARTMENT_PALETTE.length);
  });

  it('lets a chosen colour reserve itself, so no default duplicates it', () => {
    const ids = ['11', '12', '13', '14'];
    const overrides = { '11': DEPARTMENT_PALETTE[0] };
    const colours = ids.map((id) => departmentColor(id, overrides, ids));
    expect(colours.filter((c) => c === DEPARTMENT_PALETTE[0])).toHaveLength(1);
    expect(new Set(colours).size).toBe(ids.length);
  });

  it('assigns the same map whatever order the ids arrive in', () => {
    const ids = ['11', '12', '13', '14', '15'];
    expect(departmentColorMap([...ids].reverse())).toEqual(departmentColorMap(ids));
  });
});

describe('the departments on a plan', () => {
  it('lists each one once, by record id, sorted by name', () => {
    const units = [
      { department: 'Support', departmentId: '7' },
      { department: 'Finance', departmentId: '3' },
      { department: 'Finance', departmentId: '3' },
      { department: 'Engineering', departmentId: '5' },
    ];
    expect(departmentsIn(units)).toEqual([
      { id: '5', name: 'Engineering' },
      { id: '3', name: 'Finance' },
      { id: '7', name: 'Support' },
    ]);
  });

  it('stands in a name-derived id where the record named a department without identifying it', () => {
    // The local tier, and lookups that answer with a bare string. Prefixed so it can never be
    // mistaken for a real record id.
    expect(departmentsIn([{ department: 'Field Ops' }])).toEqual([{ id: 'name:field ops', name: 'Field Ops' }]);
    expect(departmentKey('  Field   Ops ')).toBe('field ops');
  });

  it('skips desks with no department rather than inventing one', () => {
    expect(departmentsIn([{ department: '   ' }, {}, { department: 'Facilities', departmentId: '9' }])).toEqual([
      { id: '9', name: 'Facilities' },
    ]);
  });

  it('returns nothing for a floor whose desks carry no department', () => {
    expect(departmentsIn([{}, {}])).toEqual([]);
  });
});
