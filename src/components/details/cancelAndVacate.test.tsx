import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Booking, Unit } from '../../lib/types';

/**
 * Vacate and Cancel booking acted on one click — a mis-click took someone off their desk or
 * cancelled their booking on the org — and Cancel stayed clickable while it ran, so a double click
 * reported "cancelled" and then "not cancelled". The plan's sidebar and the app's own Vacate.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const actions = {
  cancelBooking: vi.fn(async (_id: string) => {}),
  vacate: vi.fn(async (_id: string) => {}),
  setDate: vi.fn(),
  setTimeRange: vi.fn(),
  setSchedView: vi.fn(),
  openBookingForm: vi.fn(),
};
vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));
vi.mock('../../lib/facilioApiDataSource', () => ({ assignEmployeeToRecord: vi.fn(), resolveUnitRecord: () => null }));
vi.mock('./AssignPanel', () => ({ PeopleCard: () => null }));
vi.mock('../../lib/orgTime', () => ({ orgNow: () => ({ dateISO: '2026-11-20', minutes: 600 }) }));

const { BookPanel } = await import('./BookPanel');
const { LocalAssign } = await import('./LocalAssign');

const room = { id: 'r1', type: 'room', label: 'Meeting Room 2', geom: { kind: 'point', x: 0.5, y: 0.5 }, plan: 'workstation', room: null, isReservable: true } as Unit;
const desk = { id: 'd1', type: 'workstation', label: 'WS-01', geom: { kind: 'point', x: 0.5, y: 0.5 }, plan: 'workstation', room: null } as Unit;
const b = { id: 'bk1', unitId: 'r1', date: '2026-11-24', start: 540, end: 600, by: 'c1' } as Booking;

beforeEach(() => {
  vi.clearAllMocks();
  ctx.state = {
    selected: 'r1',
    units: [room, desk],
    bookings: [b],
    date: '2026-11-24',
    start: 660,
    end: 720,
    schedView: 'list',
    loading: false,
    planViews: { assign: true, book: true },
    enabledModules: {},
    employees: [{ id: 'c1', name: 'Omar Al Marri' }],
    assignments: { d1: 'c1' },
    busyUnitId: null,
  };
});
afterEach(cleanup);

describe('Cancel in the selected space\'s schedule', () => {
  it('asks first; backing out cancels nothing', () => {
    render(<BookPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel the 09:00–10:00 booking/ }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this booking?' });
    expect(dialog.textContent).toContain('booked by Omar Al Marri');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep booking' }));
    expect(actions.cancelBooking).not.toHaveBeenCalled();
  });

  it('cancels once on confirming, with the row\'s Cancel held until it settles', async () => {
    let settle!: () => void;
    actions.cancelBooking.mockImplementationOnce(() => new Promise<void>((r) => (settle = r)));
    render(<BookPanel />);
    const cancel = screen.getByRole('button', { name: /Cancel the 09:00–10:00 booking/ }) as HTMLButtonElement;
    fireEvent.click(cancel);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel booking' }));
    expect(actions.cancelBooking).toHaveBeenCalledTimes(1);
    expect(actions.cancelBooking).toHaveBeenCalledWith('bk1');
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).toBeNull();

    await act(async () => settle());
    await waitFor(() => expect(cancel.disabled).toBe(false));
    expect(actions.cancelBooking).toHaveBeenCalledTimes(1);
  });
});

describe('the app\'s own Vacate (no flow on the record)', () => {
  it('asks first, names who comes off, and vacates once on confirming', () => {
    render(<LocalAssign unit={desk} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vacate' }));
    const dialog = screen.getByRole('dialog', { name: 'Vacate WS-01?' });
    expect(dialog.textContent).toContain('Omar Al Marri comes off WS-01');
    expect(actions.vacate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vacate WS-01' }));
    expect(actions.vacate).toHaveBeenCalledTimes(1);
    expect(actions.vacate).toHaveBeenCalledWith('d1');
  });

  it('backing out vacates nothing', () => {
    render(<LocalAssign unit={desk} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vacate' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(actions.vacate).not.toHaveBeenCalled();
  });
});
