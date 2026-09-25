import { describe, expect, it } from 'vitest';
import { buildEmployeeFilters, DEMO_FILTER_FIELDS, mapFilterFields, matchesLocally } from './employeeFilters';
import type { FilterFieldDef } from './employeeFilters';

/**
 * The People sidebar's Filter panel. These pin two things: which of the org's fields the panel
 * offers (and with whose operators), and the exact `filters` payload a search plus ticked fields
 * become — one request, search AND each field, several values on one field OR-ed.
 */

// The shape `v2/filter/advanced/fields/employee` answers with (FilterFieldContext).
const ORG_FIELDS = [
  { name: 'name', displayName: 'Name', dataType: 'STRING', operators: [{ operatorId: 5, displayName: 'contains', valueNeeded: true }] },
  { name: 'email', displayName: 'Email', dataType: 'STRING', operators: [{ operatorId: 5, displayName: 'contains', valueNeeded: true }, { operatorId: 3, displayName: 'is', valueNeeded: true }] },
  {
    name: 'department',
    displayName: 'Department',
    dataType: 'LOOKUP',
    lookupModule: { name: 'department', displayName: 'Department' },
    operators: [
      { operatorId: 36, displayName: 'is', valueNeeded: true },
      { operatorId: 37, displayName: "isn't", valueNeeded: true },
      { operatorId: 1, displayName: 'is empty', valueNeeded: false },
      { operatorId: 35, displayName: 'lookup', valueNeeded: true, specialOperator: true },
    ],
  },
  { name: 'hrmsEmployeeId', displayName: 'HRMS Employee ID', dataType: 'STRING', operators: [{ operatorId: 5, displayName: 'contains', valueNeeded: true }] },
  { name: 'joiningDate', displayName: 'Joining date', dataType: 'DATE', operators: [{ operatorId: 16, displayName: 'is', valueNeeded: true }] },
  { name: 'employeeType', displayName: 'Employee type', dataType: 'ENUM', options: [{ value: 1, label: 'Full time' }, { value: 2, label: 'Contractor' }], operators: [{ operatorId: 54, displayName: 'is', valueNeeded: true }] },
  { name: 'designation', displayName: 'Designation', dataType: 'STRING', operators: [{ operatorId: 5, displayName: 'contains', valueNeeded: true }] },
];

describe('which fields the panel offers', () => {
  const fields = mapFilterFields(ORG_FIELDS);
  const names = fields.map((f) => f.name);

  it('leaves out Name — the search box owns it', () => {
    expect(names).not.toContain('name');
  });

  it('leaves out a type the panel cannot edit (dates)', () => {
    expect(names).not.toContain('joiningDate');
  });

  it('pins Department, Designation and HRMS Employee ID first, then the rest by label', () => {
    expect(names).toEqual(['department', 'designation', 'hrmsEmployeeId', 'email', 'employeeType']);
  });

  it("uses the org's own operators, minus the special ones it has no editor for", () => {
    const dept = fields.find((f) => f.name === 'department')!;
    expect(dept.kind).toBe('lookup');
    expect(dept.lookupModule).toBe('department');
    expect(dept.operators.map((o) => o.operatorId)).toEqual([36, 37, 1]);
    expect(dept.operators.find((o) => o.operatorId === 1)!.valueNeeded).toBe(false);
  });

  it('offers an enum as its options', () => {
    const t = fields.find((f) => f.name === 'employeeType')!;
    expect(t.kind).toBe('options');
    expect(t.options).toEqual([{ value: '1', label: 'Full time' }, { value: '2', label: 'Contractor' }]);
  });

  it('answers nothing for a response it does not recognise', () => {
    expect(mapFilterFields(undefined)).toEqual([]);
    expect(mapFilterFields({ fields: [] })).toEqual([]);
  });
});

describe('what goes to the org', () => {
  const fields = mapFilterFields(ORG_FIELDS);

  it('sends the search alone as the name / email / HRMS ID clause', () => {
    expect(buildEmployeeFilters('amr', [], fields)).toEqual({
      name: {
        operatorId: 5,
        value: ['amr'],
        orFilters: [
          { field: 'email', operatorId: 5, value: ['amr'] },
          { field: 'hrmsEmployeeId', operatorId: 5, value: ['amr'] },
        ],
      },
    });
  });

  it('sends a department filter by record id, several ids OR-ed in one clause', () => {
    expect(buildEmployeeFilters('', [{ field: 'department', operatorId: 36, values: ['101', '104'] }], fields)).toEqual({
      department: { operatorId: 36, value: ['101', '104'] },
    });
  });

  it('sends search AND filters in the same payload, one key each', () => {
    const f = buildEmployeeFilters(
      'amr',
      [
        { field: 'department', operatorId: 37, values: ['101'] },
        { field: 'designation', operatorId: 5, values: ['  Analyst '] },
      ],
      fields,
    );
    expect(Object.keys(f)).toEqual(['name', 'department', 'designation']);
    expect(f.department).toEqual({ operatorId: 37, value: ['101'] });
    expect(f.designation).toEqual({ operatorId: 5, value: ['Analyst'] });
  });

  it('sends an operator that takes no value without one', () => {
    expect(buildEmployeeFilters('', [{ field: 'department', operatorId: 1, values: [] }], fields)).toEqual({ department: { operatorId: 1 } });
  });

  it('does not send a ticked field that has nothing to filter by yet', () => {
    expect(
      buildEmployeeFilters(
        '',
        [
          { field: 'department', operatorId: 36, values: [] },
          { field: 'designation', operatorId: 5, values: ['   '] },
        ],
        fields,
      ),
    ).toEqual({});
  });

  it('never lets a filter replace the search clause', () => {
    const withName: FilterFieldDef[] = [...fields, { name: 'name', label: 'Name', kind: 'text', operators: [{ operatorId: 5, label: 'contains', valueNeeded: true }] }];
    const f = buildEmployeeFilters('amr', [{ field: 'name', operatorId: 5, values: ['zzz'] }], withName);
    expect((f.name as { value: string[] }).value).toEqual(['amr']);
  });
});

describe('the demo tier, filtered in the browser', () => {
  const amr = { id: 'c1', name: 'Amrithya', email: 'amrithya@enec.ae', hrmsEmployeeId: 'ENEC-10231', department: 'Finance' };

  it('matches a department by name, and excludes with "isn\'t"', () => {
    expect(matchesLocally(amr, [{ field: 'department', operatorId: 36, values: ['Finance', 'HR'] }], DEMO_FILTER_FIELDS)).toBe(true);
    expect(matchesLocally(amr, [{ field: 'department', operatorId: 37, values: ['Finance'] }], DEMO_FILTER_FIELDS)).toBe(false);
  });

  it('matches text with contains and is', () => {
    expect(matchesLocally(amr, [{ field: 'email', operatorId: 5, values: ['@enec'] }], DEMO_FILTER_FIELDS)).toBe(true);
    expect(matchesLocally(amr, [{ field: 'hrmsEmployeeId', operatorId: 3, values: ['enec-10231'] }], DEMO_FILTER_FIELDS)).toBe(true);
    expect(matchesLocally(amr, [{ field: 'hrmsEmployeeId', operatorId: 3, values: ['ENEC-1'] }], DEMO_FILTER_FIELDS)).toBe(false);
  });
});
