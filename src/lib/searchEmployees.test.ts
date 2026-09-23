import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * People search goes to the org as a V3 `filters` payload. These pin the exact wire format — the
 * one given for this org, `{"name":{"operatorId":5,"value":["amr"]}}`, with the other fields
 * OR-ed into the same request — because a wrong operator id or field name does not error visibly:
 * the search quietly degrades to matching whatever was already loaded.
 */

const fetchAll = vi.fn();

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customGet: vi.fn(),
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  facilioApi: { fetchAll: (...args: unknown[]) => fetchAll(...args) },
}));

// The data source also imports the floorplan renderers, whose pdf.js / CAD dependencies touch
// browser-only globals (DOMMatrix) at load. Search never reaches them, so they are stubbed out.
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

const { searchEmployees } = await import('./facilioApiDataSource');

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
    // backend groups as name ∋ q OR email ∋ q OR hrmsEmployeeId ∋ q.
    await searchEmployees('amr');
    expect(JSON.parse(filtersSent()[0])).toEqual({
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

  it('leads with the confirmed name clause, exactly as the org expects it', async () => {
    await searchEmployees('amr');
    expect(filtersSent()[0].startsWith('{"name":{"operatorId":5,"value":["amr"]')).toBe(true);
  });

  it('does not filter on guessed field names the module may not have', async () => {
    await searchEmployees('amr');
    const f = filtersSent()[0];
    expect(f).not.toContain('hrmsEmployeeID');
    expect(f).not.toContain('hrmsEmpId');
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
