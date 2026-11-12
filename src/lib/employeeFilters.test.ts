import { describe, expect, it } from 'vitest';
import { buildEmployeeFilters, DEMO_FILTER_FIELDS, employeeIdField, isLineManager, mapFilterFields, matchesLocally, searchClause, searchFirst } from './employeeFilters';
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

  it("uses the type's operators and the field's own, minus the special ones it has no editor for", () => {
    const dept = fields.find((f) => f.name === 'department')!;
    expect(dept.kind).toBe('lookup');
    expect(dept.lookupModule).toBe('department');
    expect(dept.operators.map((o) => o.operatorId)).toEqual([36, 37, 1, 2]);
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

/**
 * ENEC CAFM's own employee filter fields, as its metadata answered on 2026-11-08 (field
 * definitions only). Its fields list carries a field's EXTRA operators and nothing else, so read
 * alone it dropped Department, Designation and HRMS Employee ID and left Line Manager with only
 * "Logged In User". Its HRMS field is `hrms_employee_id_employee`; asking for `hrmsEmployeeId`
 * failed every search with "Field 'hrmsEmployeeId' does not exist".
 */
const ENEC_FIELDS = [
  { name: 'name', displayName: 'Name', dataType: 'STRING', mainField: true },
  { name: 'address', displayName: 'Address', dataType: 'LOOKUP', isSpecialType: false, lookupModule: { name: 'location' } },
  { name: 'active', displayName: 'Is Active', dataType: 'BOOLEAN', options: [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }] },
  { name: 'avatarColor', displayName: 'Avatar Color', dataType: 'STRING' },
  { name: 'company', displayName: 'Company', dataType: 'STRING' },
  { name: 'sysCreatedBy', displayName: 'Created By', dataType: 'LOOKUP', isSpecialType: true, lookupModule: { name: 'users' }, operators: [{ operatorId: 35, displayName: 'is', valueNeeded: true }] },
  { name: 'department', displayName: 'Department', dataType: 'LOOKUP', isSpecialType: false, lookupModule: { name: 'department', displayName: 'Department' } },
  { name: 'designation', displayName: 'Designation', dataType: 'STRING' },
  { name: 'desk_employee', displayName: 'Desk', dataType: 'LOOKUP', isSpecialType: false, lookupModule: { name: 'desks' } },
  { name: 'email', displayName: 'Email', dataType: 'STRING' },
  { name: 'hrms_employee_id_employee', displayName: 'HRMS Employee ID', dataType: 'STRING' },
  {
    name: 'line_manager_employee',
    displayName: 'Line Manager',
    dataType: 'LOOKUP',
    isSpecialType: false,
    lookupModule: { name: 'people', displayName: 'People' },
    operators: [{ defaultSelection: true, displayName: 'Logged In User', operatorId: 128, specialOperator: false, valueNeeded: false }],
  },
  { name: 'linemanagerhrmsid', displayName: 'Line Manager HRMS Id', dataType: 'STRING' },
  {
    name: 'locatedSpace',
    displayName: 'Located Space',
    dataType: 'LOOKUP',
    isSpecialType: false,
    lookupModule: { name: 'basespace' },
    operators: [{ displayName: 'within', operatorId: 38, specialOperator: false, valueNeeded: true }],
  },
  { name: 'peopleType', displayName: 'People Type', dataType: 'SYSTEM_ENUM', options: [{ label: 'Employee', value: 3 }] },
  { name: 'site_employee', displayName: 'Site', dataType: 'LOOKUP', isSpecialType: false, lookupModule: { name: 'site' } },
];

describe("ENEC's employee fields", () => {
  const fields = mapFilterFields(ENEC_FIELDS);
  const byName = (n: string) => fields.find((f) => f.name === n);

  it('offers Department with the lookup operators, though the org lists none for it', () => {
    expect(byName('department')!.operators.map((o) => o.label)).toEqual(['is', "isn't", 'is empty', 'is not empty']);
  });

  it('offers Line Manager as a pickable lookup, with "Logged In User" added after is / isn\'t', () => {
    const lm = byName('line_manager_employee')!;
    expect(isLineManager(lm)).toBe(true);
    expect(lm.lookupModule).toBe('people');
    expect(lm.operators.map((o) => o.operatorId)).toEqual([36, 37, 1, 2, 128]);
    expect(lm.operators.find((o) => o.operatorId === 128)!.valueNeeded).toBe(false);
    expect(searchFirst(lm)).toBe(true);
  });

  it('offers the text fields with the text operators, contains first', () => {
    expect(byName('designation')!.operators.map((o) => o.operatorId)).toEqual([5, 3, 4, 7, 1, 2]);
    expect(byName('hrms_employee_id_employee')!.kind).toBe('text');
  });

  it('offers a yes/no field with its own "is"', () => {
    expect(byName('active')!.operators.map((o) => o.operatorId)).toEqual([15]);
    expect(byName('active')!.options).toEqual([{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]);
  });

  it('leaves out lookups that cannot be listed and the field-service and system fields', () => {
    for (const n of ['address', 'sysCreatedBy', 'locatedSpace', 'avatarColor', 'peopleType', 'name']) expect(byName(n)).toBeUndefined();
  });

  it('pins Department, Line Manager, Designation, HRMS ID, Site and Desk, then the rest by label', () => {
    expect(fields.map((f) => f.name)).toEqual([
      'department',
      'line_manager_employee',
      'designation',
      'hrms_employee_id_employee',
      'site_employee',
      'desk_employee',
      'company',
      'email',
      'active',
      'linemanagerhrmsid',
    ]);
  });

  it("finds the HRMS field by its label, not the manager's HRMS field", () => {
    expect(employeeIdField(fields)).toBe('hrms_employee_id_employee');
    expect(employeeIdField([])).toBeNull();
  });

  it("searches on the org's own HRMS field, and never on a name it doesn't have", () => {
    const f = buildEmployeeFilters('omar', [], fields);
    expect(f).toEqual({
      name: {
        operatorId: 5,
        value: ['omar'],
        orFilters: [
          { field: 'email', operatorId: 5, value: ['omar'] },
          { field: 'hrms_employee_id_employee', operatorId: 5, value: ['omar'] },
        ],
      },
    });
    expect(JSON.stringify(f)).not.toContain('hrmsEmployeeId');
  });

  it('searches name OR email when the HRMS field is unknown', () => {
    expect(searchClause('omar', null)).toEqual({ name: { operatorId: 5, value: ['omar'], orFilters: [{ field: 'email', operatorId: 5, value: ['omar'] }] } });
  });

  it('sends department AND line manager by record id, as checked against ENEC (19 people)', () => {
    // Through the CMMS connector on 2026-11-08: department 10 → 36 people, line manager 28725 → 26,
    // both → 19. These are the same fields and ids, in the V3 payload the app sends.
    const f = buildEmployeeFilters(
      '',
      [
        { field: 'department', operatorId: 36, values: ['10'], labels: { '10': 'Facilities' } },
        { field: 'line_manager_employee', operatorId: 36, values: ['28725'], labels: { '28725': 'A Manager' } },
      ],
      fields,
    );
    expect(f).toEqual({ department: { operatorId: 36, value: ['10'] }, line_manager_employee: { operatorId: 36, value: ['28725'] } });
  });

  it('sends "my direct reports" (Line Manager is the logged-in user) without a value', () => {
    expect(buildEmployeeFilters('', [{ field: 'line_manager_employee', operatorId: 128, values: [] }], fields)).toEqual({ line_manager_employee: { operatorId: 128 } });
  });
});
