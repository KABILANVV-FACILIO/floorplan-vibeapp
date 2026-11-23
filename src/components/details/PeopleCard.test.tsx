import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown>, filters: [] as AppliedFilter[], focusUnit: null as unknown as (...a: unknown[]) => void, retry: (() => {}) as () => void }));

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state: ctx.state, actions: { setContactSearch: vi.fn(), dragStartContact: vi.fn(), focusUnit: ctx.focusUnit } }),
}));
vi.mock('../../lib/facilioApi', async () => {
  const real = await vi.importActual<typeof import('../../lib/facilioApi')>('../../lib/facilioApi');
  return { ...real, facilioRecordUrl: (_m: string, id: string) => `https://example.test/employee/${id}` };
});
// The org's list is asked with the filters the card holds; the test reads them back.
vi.mock('../../hooks/useLivePeople', () => ({
  useLivePeople: (_q: string, employees: Employee[], opts: { filters: AppliedFilter[]; rosterStatus?: string }) => {
    ctx.filters = opts.filters;
    const dept = opts.filters.find((f) => f.field === 'department');
    const loadFailed = !employees.length && opts.rosterStatus === 'failed';
    return { people: dept ? employees.filter((e) => dept.values.includes(e.department ?? '')) : employees, loading: false, failed: false, loadFailed, retry: ctx.retry };
  },
}));
vi.mock('../../lib/facilioApiDataSource', () => ({ fetchEmployeeFilterFields: vi.fn(), fetchPicklist: vi.fn() }));

const { PeopleCard } = await import('./AssignPanel');

function show(assign: boolean, extra: Record<string, unknown> = {}) {
  ctx.focusUnit = vi.fn();
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
    ...extra,
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

  it("says the people could not be loaded, with Retry, when the roster read failed — not an empty list", () => {
    ctx.retry = vi.fn();
    show(false, { employees: [], rosterStatus: 'failed' });
    const note = screen.getByRole('alert');
    expect(note.textContent).toContain('Couldn’t load people');
    fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));
    expect(ctx.retry).toHaveBeenCalledTimes(1);
  });

  it('says nothing of the kind while the roster is there', () => {
    show(false, { rosterStatus: 'ready' });
    expect(screen.queryByText(/Couldn’t load people/)).toBeNull();
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

  it('says a filter is on, and clears it there, without opening the Filter panel', () => {
    show(false);
    fireEvent.click(screen.getByRole('button', { name: /Department/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Finance', pressed: false }));
    expect(screen.getByText('1 filter applied')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(ctx.filters).toEqual([]);
    expect(screen.queryByText(/filter applied/)).toBeNull();
  });

  it('opens the Filter panel in the list’s place, so Clear all and Apply are there however short the list', () => {
    show(false);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.queryByText('Priya Nair')).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });
});

/**
 * A click on a person showed their desk on the plan, but only a mouse could do it: the row was a
 * div with nothing for a keyboard, and its pointer cursor hid the drag cue (new in v77).
 */
describe('showing a person\'s space from their row, without a mouse', () => {
  const desk = { id: 'd1', type: 'workstation', label: 'WS-01', geom: { kind: 'point', x: 0.5, y: 0.5 }, plan: 'workstation', floor: 'f1', room: null };
  const onPlan = { units: [desk], assignments: { d1: '1001' }, planId: 'workstation', stage: { w: 800, h: 600 }, employees: [{ id: '1001', name: '251850 - Omar Al Marri', department: 'Finance' }, PEOPLE[1]] };

  it('makes the row a button named for the space, and Enter shows it', () => {
    show(true, onPlan);
    const btn = screen.getByRole('button', { name: "Show Omar Al Marri's WS-01 on the plan" });
    expect(btn.tabIndex).toBe(0);
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(ctx.focusUnit).toHaveBeenCalledWith('d1', 800, 600);
    fireEvent.keyDown(btn, { key: ' ' });
    expect(ctx.focusUnit).toHaveBeenCalledTimes(2);
  });

  it('leaves Enter on the record icon to the icon — it opens the record, not the space', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    show(true, onPlan);
    const row = screen.getByRole('button', { name: "Show Omar Al Marri's WS-01 on the plan" });
    const icon = within(row).getByRole('button', { name: "Open Omar Al Marri's employee record" });
    fireEvent.keyDown(icon, { key: 'Enter' });
    fireEvent.click(icon);
    expect(ctx.focusUnit).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('keeps the grab cue while rows drag to assign, and points only where they cannot', () => {
    show(true, onPlan);
    expect(screen.getByRole('button', { name: /Show Omar/ }).style.cursor).toBe('grab');
    cleanup();
    show(false, onPlan);
    expect(screen.getByRole('button', { name: /Show Omar/ }).style.cursor).toBe('pointer');
  });

  it('is no button at all for someone with no space on this plan', () => {
    show(true, onPlan);
    const priya = screen.getByText('Priya Nair').closest('[draggable]') as HTMLElement;
    expect(priya.getAttribute('role')).toBeNull();
    expect(priya.getAttribute('tabindex')).toBeNull();
  });
});
