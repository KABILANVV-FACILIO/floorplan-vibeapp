import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Booking, Employee, Unit } from '../../lib/types';

/**
 * The phone's own sheets: the space sheet's Assign and Vacate, and My bookings' Cancel. They are a
 * second write path beside the desktop's, and these pin what they now share with it — nothing new
 * starts over a write already running, Vacate and Cancel ask first in the app's own dialog (the
 * phone app's WebView answers the browser's confirm() with "no"), and the people search asks the
 * org rather than only the roster loaded at start-up.
 */

const ctx = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  livePeople: { calls: [] as { query: string; enabled: boolean | undefined }[], result: null as Employee[] | null },
}));
const actions = {
  setMobSel: vi.fn(),
  setMobAssignEdit: vi.fn(),
  vacate: vi.fn(async (_id: string) => {}),
  assign: vi.fn(async () => {}),
  openBookingForm: vi.fn(),
  cancelBooking: vi.fn(async (_id: string) => {}),
};

vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));
vi.mock('../../hooks/useLivePeople', () => ({
  useLivePeople: (query: string, fallback: Employee[], opts?: { enabled?: boolean }) => {
    ctx.livePeople.calls.push({ query, enabled: opts?.enabled });
    return { people: ctx.livePeople.result ?? fallback, loading: false, failed: false };
  },
}));
vi.mock('../../lib/unitStatus', () => ({ unitStatus: () => ({ key: 'assigned', text: 'Assigned', bg: '#fff', fg: '#000' }) }));
vi.mock('../../lib/firstResponders', () => ({ responderRolesFor: () => [], rolesText: () => '' }));
vi.mock('../canvas/ResponderBadge', () => ({ ResponderGlyph: () => null }));

const { MobileUnitSheet } = await import('./MobileUnitSheet');
const { MobileMyBookings } = await import('./MobileMyBookings');

const desk = { id: 'd1', type: 'workstation', label: 'WS-01', deskType: 'ASSIGNED', geom: { kind: 'point', x: 0.5, y: 0.5 }, plan: 'workstation', room: null } as Unit;
const people: Employee[] = [
  { id: 'c1', name: 'Omar Al Marri' },
  { id: 'c2', name: 'Priya Nair' },
];

function sheet(extra: Record<string, unknown> = {}) {
  ctx.state = {
    units: [desk],
    unplacedUnits: [],
    mobSel: 'd1',
    mobileTab: 'assign',
    mobAssignEdit: false,
    planViews: { assign: true, book: true },
    assignments: { d1: 'c1' },
    employees: people,
    customMarkers: [],
    busyUnitId: null,
    date: '2026-11-24',
    start: 540,
    end: 600,
    ...extra,
  };
  return render(<MobileUnitSheet />);
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.livePeople.calls = [];
  ctx.livePeople.result = null;
});
afterEach(cleanup);

describe('the space sheet on a phone', () => {
  it('asks before vacating, and vacates once on confirming', async () => {
    sheet();
    fireEvent.click(screen.getByRole('button', { name: 'Vacate' }));
    expect(actions.vacate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Vacate WS-01?' });
    expect(dialog.textContent).toContain('Omar Al Marri comes off WS-01');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vacate WS-01' }));
    expect(actions.vacate).toHaveBeenCalledTimes(1);
    expect(actions.vacate).toHaveBeenCalledWith('d1');
  });

  it('backing out of the question vacates nothing', () => {
    sheet();
    fireEvent.click(screen.getByRole('button', { name: 'Vacate' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(actions.vacate).not.toHaveBeenCalled();
  });

  it('holds Vacate and Reassign while a write to this space is running', () => {
    sheet({ busyUnitId: 'd1' });
    expect((screen.getByRole('button', { name: 'Vacate' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reassign' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('holds the people rows too, so a second assignment cannot start over the first', () => {
    sheet({ busyUnitId: 'd1', assignments: {} });
    const row = screen.getByRole('button', { name: /Priya Nair/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(actions.assign).not.toHaveBeenCalled();
  });

  it('leaves them live while a different space is busy', () => {
    sheet({ busyUnitId: 'other' });
    expect((screen.getByRole('button', { name: 'Vacate' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks the org for the people typed, as the desktop picker does — and nothing until something is typed', () => {
    sheet({ assignments: {} });
    expect(ctx.livePeople.calls[ctx.livePeople.calls.length - 1]).toEqual({ query: '', enabled: false });
    ctx.livePeople.result = [{ id: 'c9', name: 'Zayed Not In Roster' }];
    fireEvent.change(screen.getByRole('textbox', { name: 'Search people to assign WS-01 to' }), { target: { value: 'Zay' } });
    expect(ctx.livePeople.calls[ctx.livePeople.calls.length - 1]).toEqual({ query: 'Zay', enabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Zayed Not In Roster/ }));
    expect(actions.assign).toHaveBeenCalledWith('c9', 'd1');
  });

  it('never says "No people match “”" for an empty list with nothing typed', () => {
    sheet({ assignments: {}, employees: [] });
    expect(screen.queryByText(/No people match/)).toBeNull();
    expect(screen.getByText(/Couldn’t load people/)).toBeTruthy();
  });
});

describe('My bookings on a phone', () => {
  const mine = { id: 'bk1', unitId: 'd1', date: '2026-11-24', start: 540, end: 600, by: 'c1' } as Booking;

  function myBookings() {
    ctx.state = { bookings: [mine], bookBy: 'c1', date: '2026-11-24', units: [desk], unplacedUnits: [] };
    return render(<MobileMyBookings open onClose={() => {}} />);
  }

  it('asks in the app\'s own dialog — never the browser\'s confirm() — and cancels once', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    let settle!: () => void;
    actions.cancelBooking.mockImplementationOnce(() => new Promise<void>((r) => (settle = r)));
    myBookings();
    const cancel = screen.getByRole('button', { name: /Cancel the 09:00–10:00 booking/ }) as HTMLButtonElement;
    fireEvent.click(cancel);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cancel this booking?' })).getByRole('button', { name: 'Cancel booking' }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(actions.cancelBooking).toHaveBeenCalledTimes(1);
    expect(actions.cancelBooking).toHaveBeenCalledWith('bk1');
    expect(cancel.disabled).toBe(true);
    await act(async () => settle());
    await waitFor(() => expect(cancel.disabled).toBe(false));
    confirmSpy.mockRestore();
  });

  it('names the day itself, not the evening before, west of Greenwich', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // `new Date('2026-11-24')` is midnight UTC — the Monday evening in New York.
      expect(new Date('2026-11-24').getDate()).toBe(23);
      myBookings();
      // 24 November 2026 is a Tuesday.
      expect(screen.getByText(/Tuesday/)).toBeTruthy();
    } finally {
      process.env.TZ = tz;
    }
  });
});
