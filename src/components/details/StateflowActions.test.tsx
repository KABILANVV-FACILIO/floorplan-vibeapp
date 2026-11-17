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
const openPanel = vi.fn();
const showToast = vi.fn();
const assign = vi.fn(async (_contactId: string, _unitId: string) => {});
const refreshAssignments = vi.fn(async () => {});
const invalidateUnitRecordInfo = vi.fn();
const assignEmployeeToRecord = vi.fn(async (_unit: unknown, _employeeId: string) => {});
const vacateUnitReal = vi.fn(async (_unit: unknown, _contactId: string) => ({ ok: true as const }));
// Resolves when the org has taken the holder off the desk. Default: it already has.
const waitForDeskVacated = vi.fn(async (_unit: unknown, _holder: string, _opts?: { signal?: AbortSignal }) => ({ cleared: true }));
const clearHolder = vi.fn();

/**
 * A minimal stand-in for the store, mutable because two of the things under test are app state
 * rather than component state: which record has a write in flight (`busyUnitId`) and the fact that
 * one landed (`recordNonce`). Both are written by one surface and read by every other.
 */
const store = { employees: [{ id: '7', name: 'Niviya' }], busyUnitId: null as string | null, recordNonce: 0, assignments: {} as Record<string, string> };
// Mirrors the real action: writing a holder onto the record announces the change itself, so
// every surface showing that record re-reads. The picker no longer announces on its behalf.
const markAssigned = vi.fn(() => {
  store.recordNonce += 1;
});
const setUnitBusy = vi.fn((id: string | null) => {
  store.busyUnitId = id;
});
const recordChanged = vi.fn(() => {
  store.recordNonce += 1;
});

vi.mock('../../state/FloorplanContext', () => {
  const ctx = () => ({
    state: { ...store },
    actions: { openPanel, showToast, markAssigned, assign, setUnitBusy, refreshAssignments, recordChanged, clearHolder },
  });
  // Both hooks read the same test store: nothing here pans the plan.
  return { useFloorplan: ctx, useFloorplanData: ctx };
});
vi.mock('../../lib/facilioApiDataSource', () => ({
  resolveUnitRecord: (u: { id: string }) => (/^\d+$/.test(u.id) ? { moduleName: 'desks', recordId: Number(u.id) } : null),
  invalidateUnitRecordInfo,
  assignEmployeeToRecord: (unit: unknown, employeeId: string) => assignEmployeeToRecord(unit, employeeId),
  vacateUnitReal: (unit: unknown, contactId: string) => vacateUnitReal(unit, contactId),
  waitForDeskVacated: (unit: unknown, holder: string, opts?: { signal?: AbortSignal }) => waitForDeskVacated(unit, holder, opts),
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
  store.busyUnitId = null;
  store.recordNonce = 0;
  fetchAvailableStates.mockResolvedValue(flow([]));
});
afterEach(cleanup);

describe('the buttons are whatever the API offered', () => {
  it('renders one button per returned transition, in order', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate', 'Re-assign']));
    render(<StateflowActions unit={unit} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Vacate' })).toBeDefined());
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Vacate', 'Re-assign']);
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
    // No holder on record here, so no move record either — the transition is the whole action.
    expect(vacateUnitReal).not.toHaveBeenCalled();
  });

  it('vacates a HELD desk through a move record first, then the transition', async () => {
    // The move clears the desk and writes its activity; done the other way round, the transition
    // would empty the desk and the move would have no one to take off it.
    store.assignments = { '1676024': '7' };
    try {
      fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
      render(<StateflowActions unit={unit} />);
      (await screen.findByRole('button', { name: 'Vacate' })).click();

      await waitFor(() => expect(executeStateTransition).toHaveBeenCalledWith('desks', 1676024, 1, undefined));
      expect(vacateUnitReal).toHaveBeenCalledWith(unit, '7');
      expect(vacateUnitReal.mock.invocationCallOrder[0]).toBeLessThan(executeStateTransition.mock.invocationCallOrder[0]);
    } finally {
      store.assignments = {};
    }
  });

  /*
   * The move is recorded by the request, but the org takes the holder off the desk while it
   * PROCESSES the move, afterwards. Re-read at once and the desk showed "Temporarily Vacant" and
   * "Assigned to <them>" together. These pin the order: wait for the org, then re-read, then say so.
   */
  it('keeps the desk busy and re-reads nothing until the org has taken the holder off', async () => {
    store.assignments = { '1676024': '7' };
    let release!: (v: { cleared: boolean }) => void;
    waitForDeskVacated.mockImplementationOnce(() => new Promise((r) => (release = r)));
    try {
      fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
      render(<StateflowActions unit={unit} />);
      (await screen.findByRole('button', { name: 'Vacate' })).click();

      await waitFor(() => expect(waitForDeskVacated).toHaveBeenCalledWith(unit, '7', { signal: expect.any(AbortSignal) }));
      // The move and the transition are done, but the org has not let go yet.
      expect(executeStateTransition).toHaveBeenCalled();
      expect(refreshAssignments).not.toHaveBeenCalled();
      expect(recordChanged).not.toHaveBeenCalled();
      expect(store.busyUnitId).toBe(unit.id);

      release({ cleared: true });
      await waitFor(() => expect(recordChanged).toHaveBeenCalled());
      expect(refreshAssignments).toHaveBeenCalled();
      expect(store.busyUnitId).toBeNull();
    } finally {
      store.assignments = {};
    }
  });

  it('marks the holder gone after the list read, so a stale list cannot put them back', async () => {
    store.assignments = { '1676024': '7' };
    try {
      fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
      render(<StateflowActions unit={unit} />);
      (await screen.findByRole('button', { name: 'Vacate' })).click();

      await waitFor(() => expect(clearHolder).toHaveBeenCalledWith(unit.id));
      expect(refreshAssignments.mock.invocationCallOrder[0]).toBeLessThan(clearHolder.mock.invocationCallOrder[0]);
      expect(clearHolder.mock.invocationCallOrder[0]).toBeLessThan(recordChanged.mock.invocationCallOrder[0]);
    } finally {
      store.assignments = {};
    }
  });

  it('says so plainly when the org is still updating, and claims nothing it has not seen', async () => {
    store.assignments = { '1676024': '7' };
    waitForDeskVacated.mockResolvedValueOnce({ cleared: false });
    try {
      fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
      render(<StateflowActions unit={unit} />);
      (await screen.findByRole('button', { name: 'Vacate' })).click();

      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('still updating'), 6000));
      expect(clearHolder).not.toHaveBeenCalled();
      // Still re-read, so whatever the org has by now does show.
      expect(refreshAssignments).toHaveBeenCalled();
    } finally {
      store.assignments = {};
    }
  });

  it('stops waiting for the org once the card closes, and says nothing it has not seen', async () => {
    store.assignments = { '1676024': '7' };
    let signal!: AbortSignal;
    // Like the real wait: it ends, uncleared, the moment it is stopped.
    waitForDeskVacated.mockImplementationOnce(
      (_unit, _holder, opts) =>
        new Promise((resolve) => {
          signal = opts!.signal!;
          signal.addEventListener('abort', () => resolve({ cleared: false }));
        })
    );
    try {
      fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
      const { unmount } = render(<StateflowActions unit={unit} />);
      (await screen.findByRole('button', { name: 'Vacate' })).click();
      await waitFor(() => expect(waitForDeskVacated).toHaveBeenCalled());
      expect(signal.aborted).toBe(false);

      unmount();
      expect(signal.aborted).toBe(true);
      await waitFor(() => expect(setUnitBusy).toHaveBeenLastCalledWith(null));
      expect(clearHolder).not.toHaveBeenCalled();
      // The vacate itself happened; the plan re-reads its holders once, as when the org is slow.
      expect(refreshAssignments).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('still updating'), 6000);
    } finally {
      store.assignments = {};
    }
  });

  it('stops waiting when the card moves to another record', async () => {
    store.assignments = { '1676024': '7' };
    let signal!: AbortSignal;
    waitForDeskVacated.mockImplementationOnce(
      (_unit, _holder, opts) =>
        new Promise((resolve) => {
          signal = opts!.signal!;
          signal.addEventListener('abort', () => resolve({ cleared: false }));
        })
    );
    try {
      fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
      const { rerender } = render(<StateflowActions unit={unit} />);
      (await screen.findByRole('button', { name: 'Vacate' })).click();
      await waitFor(() => expect(waitForDeskVacated).toHaveBeenCalled());

      rerender(<StateflowActions unit={{ ...unit, id: '1676025', label: 'WS-IN-06' } as Unit} />);
      expect(signal.aborted).toBe(true);
      await waitFor(() => expect(setUnitBusy).toHaveBeenLastCalledWith(null));
    } finally {
      store.assignments = {};
    }
  });

  it('does not wait on an unheld desk — there is no holder to take off', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Vacate' })).click();

    await waitFor(() => expect(recordChanged).toHaveBeenCalled());
    expect(waitForDeskVacated).not.toHaveBeenCalled();
    expect(clearHolder).not.toHaveBeenCalled();
  });

  it('reports a refused move and leaves the transition unfired', async () => {
    store.assignments = { '1676024': '7' };
    vacateUnitReal.mockResolvedValueOnce({ ok: false, reason: 'Current desk of the employee does not match with the given data' } as any);
    try {
      fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
      render(<StateflowActions unit={unit} />);
      (await screen.findByRole('button', { name: 'Vacate' })).click();

      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Current desk of the employee does not match')));
      expect(executeStateTransition).not.toHaveBeenCalled();
    } finally {
      store.assignments = {};
    }
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
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Allocate' })).click();

    const person = await screen.findByRole('button', { name: /Niviya/ });
    person.click();

    await waitFor(() => expect(assignEmployeeToRecord).toHaveBeenCalledWith(unit, '7'));
    // Mirrored into app state, so the marker's initials and the sidebar update without a reload —
    // and that write is itself the announcement, which is what makes this surface re-read.
    expect(markAssigned).toHaveBeenCalledWith(unit.id, '7');
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalledTimes(2));
    // The dialog closes once the write lands.
    await waitFor(() => expect(screen.queryByLabelText('Search people')).toBeNull());
  });

  it('reports a refused assignment as a toast and closes the picker', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Assign']));
    assignEmployeeToRecord.mockRejectedValueOnce(new Error('employee already holds a desk'));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Assign' })).click();
    (await screen.findByRole('button', { name: /Niviya/ })).click();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('already holds a desk')));
    await waitFor(() => expect(screen.queryByLabelText('Search people')).toBeNull());
  });

  it('re-reads the record and the holders after a transition', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Block']));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Block' })).click();

    // The re-read is the bumped nonce every surface watches, not a callback to the one that fired.
    await waitFor(() => expect(recordChanged).toHaveBeenCalled());
    expect(invalidateUnitRecordInfo).toHaveBeenCalled();
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalledTimes(2)); // initial load, then the refresh
    // Vacate clears `employee`; without this the marker keeps its initials until a floor reload.
    expect(refreshAssignments).toHaveBeenCalled();
  });

  it('marks the RECORD busy while the write is in flight, then clears it', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Block']));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Block' })).click();

    await waitFor(() => expect(setUnitBusy).toHaveBeenCalledWith(unit.id));
    await waitFor(() => expect(setUnitBusy).toHaveBeenLastCalledWith(null));
  });

  it('clears the busy flag even when the transition is refused', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Block']));
    executeStateTransition.mockRejectedValueOnce(new Error('nope'));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Block' })).click();

    await waitFor(() => expect(setUnitBusy).toHaveBeenLastCalledWith(null));
  });

  it('reports a refused transition instead of pretending it worked', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Block']));
    executeStateTransition.mockRejectedValueOnce(new Error('not allowed from this state'));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: 'Block' })).click();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('not allowed from this state')));
  });
});

/**
 * The sidebar's Assign/Vacate used to be the app's own, writing somewhere the plan's popover knew
 * nothing about — two surfaces offering different buttons for one record. Now both render these,
 * and the app's own controls appear only where the org has no flow to offer.
 */
describe('the caller\'s own controls stand in only when there is no flow', () => {
  const fallback = <button>Select employee</button>;

  it('shows the fallback for a unit with no org record', async () => {
    render(<StateflowActions unit={{ ...unit, id: 'u1757' } as Unit} fallback={fallback} />);
    expect(await screen.findByRole('button', { name: 'Select employee' })).toBeDefined();
    expect(fetchAvailableStates).not.toHaveBeenCalled();
  });

  /*
   * The flow could not be READ — no Facilio host to ask, or the request failed. This used to count
   * as "no flow" and show the app's own Select employee, which then assigned in the browser alone
   * and said "assigned" — while the org, which never received it, still had the old holder.
   */
  it('offers NOTHING when the flow cannot be read — never the app\'s own assign', async () => {
    fetchAvailableStates.mockRejectedValue(new Error('facilio-api: not configured'));
    const { container } = render(<StateflowActions unit={unit} fallback={fallback} />);
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: 'Select employee' })).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('offers nothing when the flow is at a state with nothing to do — the org has answered', async () => {
    // The popover hides the state (its pill already shows it), so this is the case that used to
    // fall through to the app's own Select employee.
    fetchAvailableStates.mockResolvedValue({ currentStateName: 'Occupied', transitions: [] });
    const { container } = render(<StateflowActions unit={unit} showState={false} fallback={fallback} />);
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: 'Select employee' })).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('shows the fallback when the module has a record but no transitions or state', async () => {
    fetchAvailableStates.mockResolvedValue({ currentStateName: null, transitions: [] });
    render(<StateflowActions unit={unit} fallback={fallback} />);
    expect(await screen.findByRole('button', { name: 'Select employee' })).toBeDefined();
  });

  it('shows the org\'s transitions INSTEAD of the fallback, never both', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate', 'Re-assign']));
    render(<StateflowActions unit={unit} fallback={fallback} />);
    await screen.findByRole('button', { name: 'Vacate' });
    expect(screen.queryByRole('button', { name: 'Select employee' })).toBeNull();
  });

  it('shows neither while the flow is still being read', async () => {
    fetchAvailableStates.mockReturnValue(new Promise(() => {})); // never settles
    const { container } = render(<StateflowActions unit={unit} fallback={fallback} />);
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});

describe('a record mid-write locks every surface showing it', () => {
  it('disables the buttons while another surface holds this record busy', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
    store.busyUnitId = unit.id; // as if the popover fired a transition on the same record
    render(<StateflowActions unit={unit} />);
    const btn = (await screen.findByRole('button', { name: 'Vacate' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('leaves the buttons live when the busy record is a different one', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate']));
    store.busyUnitId = '999';
    render(<StateflowActions unit={unit} />);
    const btn = (await screen.findByRole('button', { name: 'Vacate' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

/**
 * A flow can offer four or five moves. Five buttons wrapped across a 300px panel is a wall, not a
 * choice — so two stay inline and the rest go under the overflow, on both surfaces that render this.
 */
describe('more than two transitions move under the overflow', () => {
  it('leaves two or fewer inline, with no overflow control', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate', 'Block']));
    render(<StateflowActions unit={unit} />);
    await screen.findByRole('button', { name: 'Vacate' });
    expect(screen.getByRole('button', { name: 'Block' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /more action/ })).toBeNull();
  });

  it('shows the first two and hides the rest behind it', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate', 'Re-assign', 'Block', 'Retire']));
    render(<StateflowActions unit={unit} />);
    await screen.findByRole('button', { name: 'Vacate' });

    expect(screen.getByRole('button', { name: 'Re-assign' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
    expect(screen.getByRole('button', { name: '2 more actions' })).toBeDefined();
  });

  it('reveals the rest when it is pressed, and they fire like any other', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['Vacate', 'Re-assign', 'Block']));
    render(<StateflowActions unit={unit} />);
    (await screen.findByRole('button', { name: '1 more action' })).click();

    const block = await screen.findByRole('button', { name: 'Block' });
    block.click();
    await waitFor(() => expect(executeStateTransition).toHaveBeenCalledWith('desks', 1676024, 3, undefined));
  });

  it('counts the overflow, not the total', async () => {
    fetchAvailableStates.mockResolvedValue(flow(['A', 'B', 'C']));
    render(<StateflowActions unit={unit} />);
    expect(await screen.findByRole('button', { name: '1 more action' })).toBeDefined();
  });
});
