import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Booking, Building, Floor, Unit } from '../../lib/types';

/**
 * The Bookings calendar against an org: what it asks Facilio for, and when, and what it says when
 * Facilio doesn't answer. Each block pins one review finding (v77 review, 2026-11-20).
 */

// jsdom has no PointerEvent; the calendar's slot drag listens for pointer events.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

const ctx = vi.hoisted(() => ({
  api: true,
  canBook: true,
  // Whether the data source offers the site-wide floor read (the composite does; a bare tier may not).
  siteFloors: false,
  state: {} as Record<string, unknown>,
}));
const actions = {
  showToast: vi.fn(),
  openBookingForm: vi.fn(),
  // Resolves whether the cancel went through (FloorplanContext.cancelBooking).
  cancelBooking: vi.fn(async (_id: string) => true),
  setDate: vi.fn(async () => {}),
};
const fetchOrgBookableResources = vi.fn();
const fetchOrgBookingsForRange = vi.fn();
const fetchAvailableStates = vi.fn();
const getBuildings = vi.fn();
const getFloors = vi.fn();
const getSiteFloors = vi.fn();
const getBookings = vi.fn();

vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));
vi.mock('../../state/selectors', async () => {
  const real = await vi.importActual<typeof import('../../state/selectors')>('../../state/selectors');
  return { ...real, canBookFromCalendar: () => ctx.canBook };
});
vi.mock('../../lib/facilioApi', () => ({
  get isFacilioApiConfigured() {
    return ctx.api;
  },
}));
vi.mock('../../lib/facilioApiDataSource', () => ({
  bookingsScopedToUser: () => false,
  fetchOrgBookableResources: (...a: unknown[]) => fetchOrgBookableResources(...a),
  fetchOrgBookingsForRange: (...a: unknown[]) => fetchOrgBookingsForRange(...a),
}));
vi.mock('../../lib/dataSource', () => ({
  dataSource: {
    getBuildings: (...a: unknown[]) => getBuildings(...a),
    getFloors: (...a: unknown[]) => getFloors(...a),
    get getSiteFloors() {
      return ctx.siteFloors ? (...a: unknown[]) => getSiteFloors(...a) : undefined;
    },
    getBookings: (...a: unknown[]) => getBookings(...a),
  },
}));
// The booking cards' shared reader is the real one, put around this file's `fetchAvailableStates`
// and made afresh for every test, so nothing one test read is handed to the next.
const flows = vi.hoisted(() => ({ read: null as unknown as (...a: unknown[]) => Promise<unknown> }));
vi.mock('../../lib/stateflowApi', async () => {
  const real = await vi.importActual<typeof import('../../lib/stateflowApi')>('../../lib/stateflowApi');
  return {
    ...real,
    fetchAvailableStates: (...a: unknown[]) => fetchAvailableStates(...a),
    executeStateTransition: vi.fn(async () => {}),
    readFlow: (...a: unknown[]) => flows.read(...a),
  };
});
// The org's clock: Friday 20 November 2026, 10:00. The week on show runs Sun 22 – Sat 28.
vi.mock('../../lib/orgTime', () => ({ orgNow: () => ({ dateISO: '2026-11-20', minutes: 600 }) }));

const { createFlowReader } = await vi.importActual<typeof import('../../lib/stateflowApi')>('../../lib/stateflowApi');
const { BookingsView } = await import('./BookingsView');
const { IncompleteListError, RateLimitedError } = await import('../../lib/rateLimit');

const hotDesk: Unit = { id: '5001', type: 'workstation', label: 'HD-01', deskType: 'HOT', geom: { kind: 'point', x: 0.5, y: 0.5 }, plan: 'workstation', room: null } as Unit;

function booking(id: string, date: string, start: number, by = 'me'): Booking {
  return { id, unitId: hotDesk.id, date, start, end: start + 60, by } as Booking;
}

function setState(extra: Record<string, unknown> = {}) {
  ctx.state = {
    date: '2026-11-24',
    floorId: 'f1',
    units: [],
    employees: [{ id: 'me', name: 'Niviya' }],
    bookBy: 'me',
    bookingsNonce: 0,
    portfolio: [],
    activeView: 'bookings',
    // The plan's own day list (floor f1, the plan's day) — not the calendar's.
    bookings: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.api = true;
  ctx.canBook = true;
  ctx.siteFloors = false;
  flows.read = createFlowReader((m, id) => fetchAvailableStates(m, id)).read as typeof flows.read;
  setState();
  fetchOrgBookableResources.mockResolvedValue([hotDesk]);
  fetchOrgBookingsForRange.mockResolvedValue([]);
  fetchAvailableStates.mockResolvedValue({ currentStateName: 'Confirmed', transitions: [{ id: 6, name: 'Cancel' }] });
  getBookings.mockResolvedValue([]);
});
afterEach(cleanup);

const loaded = () => waitFor(() => expect(screen.queryByText('Loading bookings…')).toBeNull());

describe('booking cards read their actions only when opened', () => {
  it('lists 30 bookings with no getAvailableState call until one card\'s actions are opened', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => booking(String(9000 + i), `2026-11-${22 + (i % 7)}`, 360 + (i % 20) * 30));
    fetchOrgBookingsForRange.mockResolvedValue(thirty);
    render(<BookingsView />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /My bookings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'My bookings' });
    const opens = within(dialog).getAllByRole('button', { name: 'Actions' });
    expect(opens.length).toBe(30);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchAvailableStates).not.toHaveBeenCalled();

    fireEvent.click(opens[3]);
    expect(await within(dialog).findByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(fetchAvailableStates).toHaveBeenCalledTimes(1);
  });

  it('opens a single booking from the keyboard — a real button — and reads that one booking\'s actions', async () => {
    fetchOrgBookingsForRange.mockResolvedValue([booking('9100', '2026-11-24', 600)]);
    render(<BookingsView />);
    await loaded();

    const block = screen.getByRole('button', { name: /10:00 – 11:00 · Your booking/ });
    expect(block.tagName).toBe('BUTTON');
    expect(block.getAttribute('type')).toBe('button');
    block.focus();
    expect(document.activeElement).toBe(block);
    fireEvent.click(block);

    const preview = await screen.findByRole('dialog', { name: /Bookings ·/ });
    expect(await within(preview).findByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(fetchAvailableStates).toHaveBeenCalledTimes(1);
    expect(fetchAvailableStates).toHaveBeenCalledWith('spacebooking', 9100);
  });

  it('a transition from the calendar re-reads the calendar range, and makes no plan getBookings call', async () => {
    fetchOrgBookingsForRange.mockResolvedValue([booking('9100', '2026-11-24', 600)]);
    render(<BookingsView />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /10:00 – 11:00 · Your booking/ }));
    const preview = await screen.findByRole('dialog', { name: /Bookings ·/ });
    fireEvent.click(await within(preview).findByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cancel this booking?' })).getByRole('button', { name: 'Cancel booking' }));

    await waitFor(() => expect(fetchOrgBookingsForRange).toHaveBeenCalledTimes(2));
    expect(actions.setDate).not.toHaveBeenCalled();
    expect(getBookings).not.toHaveBeenCalled();
  });

  it('pressing a booking block never starts a slot selection under it', async () => {
    fetchOrgBookingsForRange.mockResolvedValue([booking('9100', '2026-11-24', 600)]);
    render(<BookingsView />);
    await loaded();
    const block = screen.getByRole('button', { name: /Your booking/ });
    fireEvent.pointerDown(block, { button: 0, clientY: 520 });
    fireEvent.pointerUp(window);
    expect(actions.openBookingForm).not.toHaveBeenCalled();
  });
});

describe('the plan\'s floor and the calendar', () => {
  it('moving the plan to another floor does not re-read the calendar range against the org', async () => {
    const { rerender } = render(<BookingsView />);
    await loaded();
    expect(fetchOrgBookingsForRange).toHaveBeenCalledTimes(1);

    setState({ floorId: 'f2' });
    rerender(<BookingsView />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchOrgBookingsForRange).toHaveBeenCalledTimes(1);
  });

  it('still reads the new floor\'s bookings on the local tier, which reads per floor', async () => {
    ctx.api = false;
    const { rerender } = render(<BookingsView />);
    await loaded();
    const before = getBookings.mock.calls.length;

    setState({ floorId: 'f2' });
    rerender(<BookingsView />);
    await waitFor(() => expect(getBookings.mock.calls.length).toBeGreaterThan(before));
    expect(getBookings).toHaveBeenLastCalledWith('f2', expect.any(String));
  });
});

describe('a failed read says so', () => {
  it('shows "Couldn\'t load bookings" with Retry instead of an empty week, and Retry reads again', async () => {
    fetchOrgBookingsForRange.mockRejectedValueOnce(new Error('429'));
    render(<BookingsView />);
    expect(await screen.findByText(/Couldn’t load bookings/)).toBeTruthy();

    fetchOrgBookingsForRange.mockResolvedValueOnce([booking('9100', '2026-11-24', 600)]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Your booking/ })).toBeTruthy();
    expect(screen.queryByText(/Couldn’t load bookings/)).toBeNull();
    expect(fetchOrgBookingsForRange).toHaveBeenCalledTimes(2);
  });

  it('reads the range strictly, so a read that stopped part-way is never taken for all of it', async () => {
    render(<BookingsView />);
    await loaded();
    expect(fetchOrgBookingsForRange).toHaveBeenCalledWith('2026-11-22', '2026-11-28', expect.objectContaining({ strict: true }));
  });

  it('shows the bookings a part-way read did get, and says some could not be loaded — with Retry', async () => {
    fetchOrgBookingsForRange.mockRejectedValueOnce(new IncompleteListError([booking('9100', '2026-11-24', 600)], true, 'page 2 refused'));
    render(<BookingsView />);
    expect(await screen.findByText(/Some bookings could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Your booking/ })).toBeTruthy();
    expect(screen.queryByText(/Couldn’t load bookings/)).toBeNull();

    fetchOrgBookingsForRange.mockResolvedValueOnce([booking('9100', '2026-11-24', 600)]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Some bookings could not be loaded/)).toBeNull());
    expect(fetchOrgBookingsForRange).toHaveBeenCalledTimes(2);
  });

  it('says it could not load at all when Facilio refused the first page (nothing read)', async () => {
    fetchOrgBookingsForRange.mockRejectedValueOnce(new RateLimitedError('refused'));
    render(<BookingsView />);
    expect(await screen.findByText(/Couldn’t load bookings/)).toBeTruthy();
    expect(screen.queryByText(/Some bookings could not be loaded/)).toBeNull();
  });

  it('says the bookable spaces could not be loaded, rather than that there are none, and retries', async () => {
    fetchOrgBookableResources.mockRejectedValueOnce(new Error('busy'));
    render(<BookingsView />);
    expect(await screen.findByText(/Couldn’t load the org’s bookable desks and rooms/)).toBeTruthy();
    expect(screen.queryByText(/No bookable desks or rooms yet/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchOrgBookableResources).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Couldn’t load the org’s bookable/)).toBeNull());
  });
});

describe('ticking a site in the floor filter', () => {
  const tenTowers: Building[] = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, name: `Tower ${i}` }) as Building);

  async function openFilterAndTickSite() {
    render(<BookingsView />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const siteBox = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    fireEvent.click(siteBox);
    return siteBox;
  }

  it('reads every floor of the site in ONE request — no floor list per building — and selects them all', async () => {
    ctx.siteFloors = true;
    setState({ portfolio: [{ id: 's1', name: 'Barakah', buildings: tenTowers }] });
    getSiteFloors.mockResolvedValue(Object.fromEntries(tenTowers.map((b) => [b.id, [{ id: `f-${b.id}`, name: 'Floor 1' } as Floor]])));
    const siteBox = await openFilterAndTickSite();

    await waitFor(() => expect(siteBox.checked).toBe(true));
    expect(getSiteFloors).toHaveBeenCalledTimes(1);
    expect(getSiteFloors).toHaveBeenCalledWith('s1');
    expect(getFloors).not.toHaveBeenCalled();
    expect(getBuildings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fetchOrgBookingsForRange).toHaveBeenLastCalledWith('2026-11-22', '2026-11-28', expect.objectContaining({ floorIds: tenTowers.map((b) => `f-${b.id}`) })));
  });

  it('a failed site read says "Couldn\'t load floors" with Retry — never "no floors" — and Retry reads once more', async () => {
    ctx.siteFloors = true;
    setState({ portfolio: [{ id: 's1', name: 'Barakah', buildings: tenTowers }] });
    getSiteFloors.mockRejectedValueOnce(new Error('429'));
    const siteBox = await openFilterAndTickSite();

    const line = await screen.findByRole('alert');
    expect(line.textContent).toContain('Couldn’t load floors');
    await waitFor(() => expect(siteBox.disabled).toBe(false));
    expect(siteBox.checked).toBe(false);
    // Nothing was kept as "this site has no floors", and no building claims to still be loading.
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(getFloors).not.toHaveBeenCalled();

    getSiteFloors.mockResolvedValueOnce(Object.fromEntries(tenTowers.map((b) => [b.id, [{ id: `f-${b.id}`, name: 'Floor 1' } as Floor]])));
    fireEvent.click(within(line).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(getSiteFloors).toHaveBeenCalledTimes(2);
    // Retry reads; ticking stays the user's. The floors are in hand now, so the tick reads nothing.
    fireEvent.click(siteBox);
    await waitFor(() => expect(siteBox.checked).toBe(true));
    expect(getSiteFloors).toHaveBeenCalledTimes(2);
  });

  it('a failed building expand says so with Retry, rather than showing the building as floorless', async () => {
    setState({ portfolio: [{ id: 's1', name: 'Barakah', buildings: tenTowers.slice(0, 1) }] });
    getFloors.mockRejectedValueOnce(new Error('busy'));
    render(<BookingsView />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Barakah' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Tower 0' }));

    const line = await screen.findByRole('alert');
    expect(line.textContent).toContain('Couldn’t load floors');
    getFloors.mockResolvedValueOnce([{ id: 'f-b0', name: 'Floor 1' } as Floor]);
    fireEvent.click(within(line).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Floor 1')).toBeTruthy();
    expect(getFloors).toHaveBeenCalledTimes(2);
  });

  it('an answer that lands after the popover closed ticks nothing in the next one', async () => {
    ctx.siteFloors = true;
    setState({ portfolio: [{ id: 's1', name: 'Barakah', buildings: tenTowers }] });
    let answer!: (r: Record<string, Floor[]>) => void;
    getSiteFloors.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await openFilterAndTickSite();
    await waitFor(() => expect(getSiteFloors).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(document.body); // closes the popover
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ })); // and opens a fresh one
    const siteBox = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    // The old tick holds nothing shut here.
    expect(siteBox.disabled).toBe(false);

    await act(async () => answer({ b0: [{ id: 'f-b0', name: 'Floor 1' } as Floor] }));
    expect(siteBox.checked).toBe(false);
    expect(screen.queryByText(/Active filters/)).toBeNull();
  });

  it('without a site-wide read, reads its buildings\' floors two at a time, and selects every floor as before', async () => {
    const buildings: Building[] = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, name: `Tower ${i}` }) as Building);
    setState({ portfolio: [{ id: 's1', name: 'Barakah' }] });
    getBuildings.mockResolvedValue(buildings);
    const waiting: { id: string; resolve: (f: Floor[]) => void }[] = [];
    let maxInFlight = 0;
    getFloors.mockImplementation(
      (id: string) =>
        new Promise<Floor[]>((resolve) => {
          waiting.push({ id, resolve });
          maxInFlight = Math.max(maxInFlight, waiting.length);
        })
    );
    render(<BookingsView />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const siteBox = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    fireEvent.click(siteBox);
    await waitFor(() => expect(getFloors).toHaveBeenCalled());
    // Its box waits until every floor has arrived; the buildings say "Loading…" meanwhile.
    expect(siteBox.disabled).toBe(true);
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);

    while (getFloors.mock.calls.length < 10 || waiting.length) {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      expect(waiting.length).toBeLessThanOrEqual(2);
      const next = waiting.shift()!;
      await act(async () => next.resolve([{ id: `f-${next.id}`, name: 'Floor 1' } as Floor]));
    }
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(getFloors).toHaveBeenCalledTimes(10);
    await waitFor(() => expect(siteBox.disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fetchOrgBookingsForRange).toHaveBeenLastCalledWith('2026-11-22', '2026-11-28', expect.objectContaining({ floorIds: buildings.map((b) => `f-${b.id}`) })));
  });
});

describe('cancelling a booking with no org record', () => {
  beforeEach(() => {
    ctx.api = false;
    getBookings.mockImplementation(async (_floor: string, d: string) => (d === '2026-11-24' ? [booking('local-1', d, 600)] : []));
  });

  it('asks first, holds the button while it runs, and keeps a refused booking listed', async () => {
    let settle!: (ok: boolean) => void;
    actions.cancelBooking.mockImplementationOnce(() => new Promise<boolean>((r) => (settle = r)));
    render(<BookingsView />);
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /Your booking/ }));
    const preview = await screen.findByRole('dialog', { name: /Bookings ·/ });
    fireEvent.click(within(preview).getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('dialog', { name: 'Cancel this booking?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel booking' }));

    expect(actions.cancelBooking).toHaveBeenCalledTimes(1);
    expect(actions.cancelBooking).toHaveBeenCalledWith('local-1');
    const running = within(preview).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    // Still listed while the cancel is on its way — nothing is taken off before it settles.
    expect(screen.getByRole('button', { name: /Your booking/ })).toBeTruthy();

    // Refused: the action toasts and changes nothing. The range is read again and it is still there,
    // and the preview stays open on it.
    const readsBefore = getBookings.mock.calls.length;
    await act(async () => settle(false));
    await waitFor(() => expect(getBookings.mock.calls.length).toBeGreaterThan(readsBefore));
    await loaded();
    expect(screen.getByRole('button', { name: /Your booking/ })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /Bookings ·/ })).toBeTruthy();
  });

  it('closes the preview once the cancel went through, and reads the range again', async () => {
    render(<BookingsView />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Your booking/ }));
    const preview = await screen.findByRole('dialog', { name: /Bookings ·/ });
    fireEvent.click(within(preview).getByRole('button', { name: 'Cancel' }));
    const readsBefore = getBookings.mock.calls.length;
    await act(async () => fireEvent.click(within(screen.getByRole('dialog', { name: 'Cancel this booking?' })).getByRole('button', { name: 'Cancel booking' })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Bookings ·/ })).toBeNull());
    await waitFor(() => expect(getBookings.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it('backing out of the question cancels nothing', async () => {
    render(<BookingsView />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Your booking/ }));
    const preview = await screen.findByRole('dialog', { name: /Bookings ·/ });
    fireEvent.click(within(preview).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cancel this booking?' })).getByRole('button', { name: 'Keep booking' }));
    expect(actions.cancelBooking).not.toHaveBeenCalled();
  });
});

describe('picking a slot', () => {
  const col = (date: string) => document.querySelector(`[data-daycol="${date}"]`) as HTMLElement;

  it('opens the form for the half-hour pressed, with a mouse as before', async () => {
    render(<BookingsView />);
    await loaded();
    // 600px down the column, at 52px an hour, is 11:32 — the 11:30 slot.
    fireEvent.pointerDown(col('2026-11-24'), { button: 0, clientY: 600 });
    fireEvent.pointerUp(window);
    expect(actions.openBookingForm).toHaveBeenCalledWith(expect.objectContaining({ unitId: hotDesk.id, date: '2026-11-24', start: 690, end: 720, fromCalendar: true }));
  });

  it('opens nothing when the browser takes the touch over to scroll', async () => {
    render(<BookingsView />);
    await loaded();
    fireEvent.pointerDown(col('2026-11-24'), { button: 0, clientY: 600 });
    fireEvent(window, new window.PointerEvent('pointercancel'));
    fireEvent.pointerUp(window);
    expect(actions.openBookingForm).not.toHaveBeenCalled();
  });

  it('leaves the window alone once the view has gone mid-drag', async () => {
    const { unmount } = render(<BookingsView />);
    await loaded();
    fireEvent.pointerDown(col('2026-11-24'), { button: 0, clientY: 600 });
    unmount();
    fireEvent.pointerUp(window);
    expect(actions.openBookingForm).not.toHaveBeenCalled();
  });

  it('offers "New booking" for the keyboard, opening the same form on the next slot of the day in view', async () => {
    render(<BookingsView />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'New booking' }));
    expect(actions.openBookingForm).toHaveBeenCalledWith(expect.objectContaining({ unitId: hotDesk.id, date: '2026-11-24', start: 540, end: 570 }));
  });

  it('offers no "New booking" to a role that cannot book from the calendar', async () => {
    ctx.canBook = false;
    render(<BookingsView />);
    await loaded();
    expect(screen.queryByRole('button', { name: 'New booking' })).toBeNull();
  });
});
