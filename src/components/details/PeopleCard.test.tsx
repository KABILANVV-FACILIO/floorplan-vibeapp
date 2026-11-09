import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppliedFilter } from '../../lib/employeeFilters';
import type { Employee } from '../../lib/types';

/**
 * The People list beside the plan (ENEC, 2026-11-09): it stays when the role cannot assign, but
 * nothing drags onto the plan then; and a Department picker under the search narrows it.
 */

const PEOPLE: Employee[] = [
  { id: 'c1', name: 'Omar Al Marri', department: 'Finance' },
  { id: 'c2', name: 'Priya Nair', department: 'Engineering' },
];

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown>, filters: [] as AppliedFilter[] }));

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state: ctx.state, actions: { setContactSearch: vi.fn(), dragStartContact: vi.fn() } }),
}));
// The org's list is asked with the filters the card holds; the test reads them back.
vi.mock('../../hooks/useLivePeople', () => ({
  useLivePeople: (_q: string, employees: Employee[], opts: { filters: AppliedFilter[] }) => {
    ctx.filters = opts.filters;
    const dept = opts.filters.find((f) => f.field === 'department');
    return { people: dept ? employees.filter((e) => dept.values.includes(e.department ?? '')) : employees, loading: false, failed: false };
  },
}));
vi.mock('../../lib/facilioApiDataSource', () => ({ fetchEmployeeFilterFields: vi.fn(), fetchPicklist: vi.fn() }));

const { PeopleCard } = await import('./AssignPanel');

function show(assign: boolean) {
  ctx.state = {
    planViews: { assign, book: false },
    contactSearch: '',
    employees: PEOPLE,
    units: [],
    assignments: {},
    departments: [],
    departmentColors: {},
    enabledModules: {},
    floorId: 'f1',
    loading: false,
  };
  return render(<PeopleCard />);
}

const row = (name: string) => screen.getByText(name).closest('[draggable]') as HTMLElement;

afterEach(cleanup);

describe('the People list beside the plan', () => {
  it('drags people onto the plan only with the Assignment right', () => {
    show(true);
    expect(row('Omar Al Marri').getAttribute('draggable')).toBe('true');
    expect(screen.queryByText(/Drag a person onto a desk/)).not.toBeNull();
  });

  it('lists people without it, but nothing drags and nothing says to', () => {
    show(false);
    expect(screen.getByText('Priya Nair')).toBeTruthy();
    expect(row('Omar Al Marri').getAttribute('draggable')).toBe('false');
    expect(screen.queryByText(/Drag a person onto a desk/)).toBeNull();
  });

  it("narrows to a department's people from the picker under the search, as the Filter panel's own Department filter", () => {
    show(false);
    const picker = screen.getByRole('button', { name: /Department/ });
    expect(picker.textContent).toContain('All');
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('button', { name: 'Finance', pressed: false }));
    expect(ctx.filters).toEqual([{ field: 'department', operatorId: 36, values: ['Finance'], labels: { Finance: 'Finance' } }]);
    expect(screen.queryByText('Priya Nair')).toBeNull();
    expect(screen.getAllByText('Omar Al Marri').length).toBe(1);
    expect(picker.textContent).toContain('Finance');
    // One filter, counted once on the Filter button.
    expect(screen.getByRole('button', { name: 'Filter, 1 applied' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all departments' }));
    expect(ctx.filters).toEqual([]);
    expect(screen.getByText('Priya Nair')).toBeTruthy();
  });
});
