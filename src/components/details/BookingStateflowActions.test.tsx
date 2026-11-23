import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * A booking card's actions are the org's transitions on its `spacebooking` record. Every card used
 * to read them the moment it appeared — thirty bookings, thirty calls at once against one
 * per-minute limit — and read them again on every `recordNonce` bump, which every desk assign on
 * the plan makes. These pin the replacement: read when opened, shared while in flight, re-read
 * only after this card's own transition.
 */

const fetchAvailableStates = vi.fn();
const executeStateTransition = vi.fn(async (..._a: unknown[]) => {});
const showToast = vi.fn();
const setDate = vi.fn(async () => {});
const store = { date: '2026-11-24', recordNonce: 0, activeView: 'map' as string, bookings: [] as { id: string }[] };

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state: { ...store }, actions: { showToast, setDate } }),
}));
// The shared reader is the real one, put around this file's `fetchAvailableStates`, and made afresh
// for every test so nothing one test read is handed to the next.
const flows = vi.hoisted(() => ({ read: null as unknown as (...a: unknown[]) => Promise<unknown> }));
vi.mock('../../lib/stateflowApi', async () => {
  const real = await vi.importActual<typeof import('../../lib/stateflowApi')>('../../lib/stateflowApi');
  return {
    ...real,
    fetchAvailableStates: (...a: unknown[]) => fetchAvailableStates(...a),
    executeStateTransition: (...a: unknown[]) => executeStateTransition(...a),
    readFlow: (...a: unknown[]) => flows.read(...a),
  };
});
const { createFlowReader } = await vi.importActual<typeof import('../../lib/stateflowApi')>('../../lib/stateflowApi');

const { BookingStateflowActions } = await import('./BookingStateflowActions');

const flow = { currentStateName: 'Confirmed', transitions: [{ id: 5, name: 'Check In' }, { id: 6, name: 'Cancel' }] };

beforeEach(() => {
  vi.clearAllMocks();
  store.recordNonce = 0;
  store.activeView = 'map';
  store.bookings = [];
  flows.read = createFlowReader((m, id) => fetchAvailableStates(m, id)).read as typeof flows.read;
  fetchAvailableStates.mockResolvedValue(flow);
});
afterEach(cleanup);

describe('reading a booking\'s actions', () => {
  it('asks nothing until the card\'s actions are opened, then asks once', async () => {
    render(<BookingStateflowActions recordId={101} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchAvailableStates).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('button', { name: 'Check In' })).toBeTruthy();
    expect(fetchAvailableStates).toHaveBeenCalledTimes(1);
    expect(fetchAvailableStates).toHaveBeenCalledWith('spacebooking', 101);
  });

  it('reads straight away where the card is the one booking on show', async () => {
    render(<BookingStateflowActions recordId={101} autoLoad />);
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
  });

  it('shares one request between two cards of the same booking', async () => {
    let answer!: (f: unknown) => void;
    fetchAvailableStates.mockImplementation(() => new Promise((r) => (answer = r)));
    render(
      <>
        <BookingStateflowActions recordId={202} autoLoad />
        <BookingStateflowActions recordId={202} autoLoad />
      </>
    );
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalled());
    expect(fetchAvailableStates).toHaveBeenCalledTimes(1);
    await act(async () => answer(flow));
    expect(screen.getAllByRole('button', { name: 'Check In' }).length).toBe(2);
  });

  it('does not re-read when some other record changes', async () => {
    const { rerender } = render(<BookingStateflowActions recordId={101} autoLoad />);
    await screen.findByRole('button', { name: 'Check In' });
    store.recordNonce = 7; // a desk was assigned on the plan
    rerender(<BookingStateflowActions recordId={101} autoLoad />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchAvailableStates).toHaveBeenCalledTimes(1);
  });

  it('re-reads its own record after its own transition, and tells the calendar', async () => {
    const onChanged = vi.fn();
    render(<BookingStateflowActions recordId={101} autoLoad onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(executeStateTransition).toHaveBeenCalledWith('spacebooking', 101, 5, undefined));
    await waitFor(() => expect(fetchAvailableStates).toHaveBeenCalledTimes(2));
    expect(fetchAvailableStates).toHaveBeenLastCalledWith('spacebooking', 101);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The plan is on screen: its day list holds bookings this may have changed.
    expect(setDate).toHaveBeenCalledWith('2026-11-24');
  });

  it('a transition from the calendar re-reads the calendar, not the plan\'s day list', async () => {
    store.activeView = 'bookings';
    const onChanged = vi.fn();
    render(<BookingStateflowActions recordId={101} autoLoad onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(setDate).not.toHaveBeenCalled();
  });

  it('…unless the plan\'s day list holds this very booking, which would otherwise still show it', async () => {
    store.activeView = 'bookings';
    store.bookings = [{ id: '101' }];
    render(<BookingStateflowActions recordId={101} autoLoad />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(setDate).toHaveBeenCalledWith('2026-11-24'));
  });
});

describe('a read that fails', () => {
  it('says so once opened, and Retry reads again', async () => {
    fetchAvailableStates.mockRejectedValueOnce(new Error('429'));
    render(<BookingStateflowActions recordId={101} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByText(/Couldn’t read this booking’s actions/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Check In' })).toBeTruthy();
    expect(fetchAvailableStates).toHaveBeenCalledTimes(2);
  });
});

describe('cancelling a booking asks first', () => {
  it('opens the confirmation; backing out cancels nothing', async () => {
    render(<BookingStateflowActions recordId={101} autoLoad />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep booking' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(executeStateTransition).not.toHaveBeenCalled();
  });

  it('cancels once on confirming, with the button held while it runs', async () => {
    let finish!: () => void;
    executeStateTransition.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    const onChanged = vi.fn();
    render(<BookingStateflowActions recordId={101} autoLoad onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel booking' }));

    await waitFor(() => expect(executeStateTransition).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(executeStateTransition).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(executeStateTransition).toHaveBeenCalledWith('spacebooking', 101, 6, undefined);
    expect(showToast).toHaveBeenCalledWith('Booking: Cancel');
  });

  it('says a refused cancel out loud and does not report a change', async () => {
    executeStateTransition.mockRejectedValueOnce(new Error('already checked in'));
    const onChanged = vi.fn();
    render(<BookingStateflowActions recordId={101} autoLoad onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel booking' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('already checked in')));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('a step that needs a comment', () => {
  it('asks in the app\'s dialog and sends the comment escaped', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    fetchAvailableStates.mockResolvedValue({ currentStateName: 'Requested', transitions: [{ id: 9, name: 'Reject', commentRequired: true }] });
    render(<BookingStateflowActions recordId={101} autoLoad />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Comment for “Reject”'), { target: { value: 'room <closed>' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(executeStateTransition).toHaveBeenCalledWith('spacebooking', 101, 9, { transitionCommentData: { body: 'room <closed>', bodyHTML: 'room &lt;closed&gt;' } })
    );
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });
});
