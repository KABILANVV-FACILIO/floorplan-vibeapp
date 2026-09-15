import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Unit } from '../../lib/types';

/**
 * Assign / Re-assign / Vacate used to be hardcoded in the popover off the app's own view of
 * occupancy, so they showed whether or not the org's flow allowed the move — and whatever the flow
 * DID allow never showed at all. These pin the replacement: the buttons are exactly the transitions
 * the API returned, and nothing else.
 */

const executeStateTransition = vi.fn(async () => {});
const fetchAvailableStates = vi.fn();
const setWebReassign = vi.fn();
const openPanel = vi.fn();
const showToast = vi.fn();
const invalidateUnitRecordInfo = vi.fn();
const assignEmployeeToRecord = vi.fn(async (_unit: unknown, _employeeId: string) => {});

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplan: () => ({ state: { employees: [{ id: '7', name: 'Niviya' }] }, actions: { setWebReassign, openPanel, showToast } }),
}));
vi.mock('../../lib/facilioApiDataSource', () => ({
  resolveUnitRecord: (u: { id: string }) => (/^\d+$/.test(u.id) ? { moduleName: 'desks', recordId: Number(u.id) } : null),
  invalidateUnitRecordInfo,
  assignEmployeeToRecord: (unit: unknown, employeeId: string) => assignEmployeeToRecord(unit, employeeId),
}));
vi.mock('../../lib/stateflowApi', async () => {
  const real = await vi.importActual<typeof import('../../lib/stateflowApi')>('../../lib/stateflowApi');
  return { ...real, fetchAvailableStates, executeStateTransition };
});

const { StateflowActions } = await import('./StateflowActions');

const unit = { id: '1676024', type: 'workstation', label: 'WS-IN-05' } as Unit;
const flow = (names: string[], currentStateName = 'In Use') => ({
  currentStateName,
  transitions: names.map((name, i) => ({ id: i + 1, name })),
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchAvailableStates.mockResolvedValue(flow([]));
});
afterEach(cleanup);

describe('the buttons are whatever the API offered', () => {
  it('renders one button per returned transition, in order', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate', 'Re-assign', 'Block']));
    render(<StateflowActions unit={unit} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Vacate' })).toBeDefined());
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Vacate', 'Re-assign', 'Block']);
  });

  it('renders NOTHING when the flow offers no transitions and no state', async () => {
    fetchAvailableStates.mockResolvedValue({ currentStateName: null, transitions: [] });
    const { container } = render(<StateflowActions unit={unit} />);
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the endpoint is unreachable, rather than an error', async () => {
    fetchAvailableStates.mockRejectedValue(new Error('404'));
    const { container } = render(<StateflowActions unit={unit} />);
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('never asks at all for a unit with no org record', async () => {
    render(<StateflowActions unit={{ ...unit, id: 'u1757' } as Unit} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchAvailableStates).not.toHaveBeenCalled();
  });

  it('shows the state row only when the caller wants it', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate'], 'Occupied'));
    const { container, rerender } = render(<StateflowActions unit={unit} showState={false} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Vacate' })).toBeDefined());
    expect(container.textContent).not.toContain('Occupied');

    rerender(<StateflowActions unit={unit} showState />);
    await waitFor(() => expect(container.textContent).toContain('Occupied'));
  });
});

describe('what a button does depends on the transition', () => {
  it('fires Vacate straight at the transition API', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
    render(<StateflowActions unit={unit} />);
    const btn = await screen.findByRole('button', { name: 'Vacate' });
    btn.click();

    await waitFor(() => expect(executeStateTransition).toHaveBeenCalledWith('desks', 1676024, 1, undefined));
    expect(openPanel).not.toHaveBeenCalled();
    expect(setWebReassign).not.toHaveBeenCalled();
  });

  it.each(['Assign', 'Re-assign', 'Allocate'])('opens the people picker for %s instead of firing', async (name) => {
    // Choosing the person IS the action; the transition follows the write.
    fetchAvailableStates.mockResolvedValue(flow([name]));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name })).click();

    await waitFor(() => expect(screen.getByLabelText('Search people')).toBeDefined());
    expect(executeStateTransition).not.toHaveBeenCalled();
  });

  it.each(['Deallocate', 'Unassign'])('fires %s rather than opening the picker', async (name) => {
    // These contain an assign-ish word but mean the opposite.
    fetchAvailableStates.mockResolvedValue(flow([name]));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name })).click();

    await waitFor(() => expect(executeStateTransition).toHaveBeenCalled());
    expect(screen.queryByLabelText('Search people')).toBeNull();
  });

  it('writes the picked person onto the record, and refreshes', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Allocate']));
    const onChanged = vi.fn();
    render(<StateflowActions unit={unit} onChanged={onChanged} />);
    (await screen.findByRole('button', { name: 'Allocate' })).click();

    const person = await screen.findByRole('button', { name: /Niviya/ });
    person.click();

    await waitFor(() => expect(assignEmployeeToRecord).toHaveBeenCalledWith(unit, '7'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // The dialog closes once the write lands.
    await waitFor(() => expect(screen.queryByLabelText('Search people')).toBeNull());
  });

  it('keeps the picker open and names the reason when the org refuses the assignment', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Assign']));
    assignEmployeeToRecord.mockRejectedValueOnce(new Error('employee already holds a desk'));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Assign' })).click();
    (await screen.findByRole('button', { name: /Niviya/ })).click();

    await waitFor(() => expect(screen.getByText(/already holds a desk/)).toBeDefined());
    expect(screen.getByLabelText('Search people')).toBeDefined();
  });

  it('re-reads the record after a transition, so the details around it update', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Block']));
    const onChanged = vi.fn();
    render(<StateflowActions unit={unit} onChanged={onChanged} />);
    (await screen.findByRole('button', { name: 'Block' })).click();

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(invalidateUnitRecordInfo).toHaveBeenCalled();
    expect(fetchAvailableStates).toHaveBeenCalledTimes(2); // initial load, then the refresh
  });

  it('reports a refused transition instead of pretending it worked', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Block']));
    executeStateTransition.mockRejectedValueOnce(new Error('not allowed from this state'));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Block' })).click();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('not allowed from this state')));
  });
});
