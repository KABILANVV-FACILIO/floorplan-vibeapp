import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * People search goes to the org as a V3 `filters` payload. These pin the exact wire format — the
 * one given for this org, `{"name":{"operatorId":5,"value":["amr"]}}`, with the other fields
 * OR-ed into the same request — because a wrong operator id or field name does not error visibly:
 * the search quietly degrades to matching whatever was already loaded.
 */

const fetchAll = vi.fn();
// The org's employee filter fields — where the search learns the HRMS field's own name. ENEC's.
const customGet = vi.fn(async (path: string) =>
  path === 'v2/filter/advanced/fields/employee'
    ? { result: { fields: [{ name: 'email', displayName: 'Email', dataType: 'STRING' }, { name: 'hrms_employee_id_employee', displayName: 'HRMS Employee ID', dataType: 'STRING' }] } }
    : null,
);

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customGet: (...args: unknown[]) => customGet(...(args as [string])),
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  facilioApi: { fetchAll: (...args: unknown[]) => fetchAll(...args) },
}));

// The data source also imports the floorplan renderers, whose pdf.js / CAD dependencies touch
// browser-only globals (DOMMatrix) at load. Search never reaches them, so they are stubbed out.
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

const { fetchPicklist, mapEmployee, searchEmployees } = await import('./facilioApiDataSource');

beforeEach(() => {
  fetchAll.mockReset();
  fetchAll.mockResolvedValue({ error: null, list: [] });
});

function filtersSent(): string[] {
  return fetchAll.mock.calls.map(([, params]) => (params as { filters: string }).filters);
}

describe('people search asks the org', () => {
  it('sends ONE request, whatever the number of fields searched', async () => {
    await searchEmployees('amr');
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(fetchAll.mock.calls[0][0]).toBe('employee');
  });

  it('sends every field in one filters payload, OR-ed through orFilters', async () => {
    // V3 ANDs top-level keys, so the other fields hang off `name` as orFilters — the shape the
    // backend groups as name ∋ q OR email ∋ q OR HRMS ID ∋ q — the HRMS field under the org's
    // own name, read from its filter fields.
    await searchEmployees('amr');
    expect(JSON.parse(filtersSent()[0])).toEqual({
      name: {
        operatorId: 5,
        value: ['amr'],
        orFilters: [
          { field: 'email', operatorId: 5, value: ['amr'] },
          { field: 'hrms_employee_id_employee', operatorId: 5, value: ['amr'] },
        ],
      },
    });
  });

  it('leads with the confirmed name clause, exactly as the org expects it', async () => {
    await searchEmployees('amr');
    expect(filtersSent()[0].startsWith('{"name":{"operatorId":5,"value":["amr"]')).toBe(true);
  });

  it('does not filter on guessed field names the module may not have', async () => {
    await searchEmployees('amr');
    const f = filtersSent()[0];
    expect(f).not.toContain('hrmsEmployeeID');
    expect(f).not.toContain('hrmsEmpId');
    expect(f).not.toContain('"hrmsEmployeeId"');
  });

  it('returns the people the org answered with', async () => {
    fetchAll.mockResolvedValue({ error: null, list: [{ id: 7, name: 'Amrithya', email: 'amr@enec.ae', hrmsEmployeeId: 'AMR-01' }] });
    const people = await searchEmployees('amr');
    expect(people).toEqual([expect.objectContaining({ id: '7', name: 'Amrithya', hrmsEmployeeId: 'AMR-01' })]);
  });

  it('tells a failed request apart from "nobody matches"', async () => {
    fetchAll.mockResolvedValue({ error: { message: 'bad field' }, list: null });
    expect(await searchEmployees('amr')).toBeNull();
    fetchAll.mockResolvedValue({ error: null, list: [] });
    expect(await searchEmployees('amr')).toEqual([]);
  });

  it('sends nothing for an empty query', async () => {
    expect(await searchEmployees('   ')).toEqual([]);
    expect(fetchAll).not.toHaveBeenCalled();
  });
});

describe("an employee record's HRMS ID", () => {
  it("is read from the org's own field name", () => {
    expect(mapEmployee({ id: 7, name: 'Omar', hrms_employee_id_employee: '100231' }).hrmsEmployeeId).toBe('100231');
    expect(mapEmployee({ id: 7, name: 'Omar', hrms_employee_id: 'E-9' }).hrmsEmployeeId).toBe('E-9');
  });
});

describe("a lookup's choices come from the org's picklist", () => {
  it('asks v3/picklist for the module, searched, with the picked ids included', async () => {
    customGet.mockResolvedValueOnce({ code: 0, data: { pickList: [{ value: 28725, label: 'A Manager', secondaryLabel: 'a@enec.ae' }, { value: 3, label: 'B' }] } } as never);
    const res = await fetchPicklist('people', { search: ' om ', perPage: 2, defaultIds: ['28725'] });
    expect(customGet).toHaveBeenLastCalledWith('v3/picklist/people', { page: 1, perPage: 2, search: 'om', default: '28725' });
    expect(res).toEqual({ options: [{ value: '28725', label: 'A Manager', secondary: 'a@enec.ae' }, { value: '3', label: 'B' }], more: true });
  });

  it('still lists when the server refuses the picked ids, asking once more without them', async () => {
    customGet.mockResolvedValueOnce({ code: 400, message: 'bad param' } as never).mockResolvedValueOnce({ code: 0, data: { pickList: [{ value: 10, label: 'Facilities' }] } } as never);
    const res = await fetchPicklist('department', { defaultIds: ['10'] });
    expect(customGet).toHaveBeenLastCalledWith('v3/picklist/department', { page: 1, perPage: 50 });
    expect(res?.options).toEqual([{ value: '10', label: 'Facilities' }]);
  });

  it('says so when the org refuses, rather than answering an empty list', async () => {
    customGet.mockResolvedValueOnce({ code: 403, message: 'no access' } as never);
    expect(await fetchPicklist('department')).toBeNull();
    customGet.mockRejectedValueOnce(new Error('network'));
    expect(await fetchPicklist('department')).toBeNull();
  });
});
