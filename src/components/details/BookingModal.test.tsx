import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Unit } from '../../lib/types';

/**
 * The form's resource field was computed twice: once in a `useMemo` near the top of the component
 * and again further down. Both call predicates that read `isRoom`, a const declared BELOW the
 * memo — and a function declaration hoists, so the memo's call landed in that const's temporal
 * dead zone. The first render where the form's fields had arrived AND a resource was picked threw
 * "Cannot access 'isRoom' before initialization", and the booking modal never opened.
 *
 * This mounts that exact moment: a loaded form carrying a `rooms` lookup, and a room to book.
 */

const room: Unit = { id: '819849', type: 'room', label: 'Meeting Room 2', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: '5150', plan: 'workstation' };

const formSummary = { id: 7, name: 'default_spacebooking', displayName: 'Space Booking' };
const formMeta = {
  id: 7,
  name: 'default_spacebooking',
  displayName: 'Space Booking',
  moduleName: 'spacebooking' as const,
  // The `rooms` lookup is the resource field — reaching it is what read `isRoom`.
  fields: [
    { name: 'space', label: 'Location', required: true, type: 'LOOKUP_SIMPLE', lookupModule: 'rooms', sequence: 1 },
    { name: 'purpose', label: 'Purpose', required: false, type: 'TEXTBOX', sequence: 2 },
  ],
};

const state = {
  bookForm: { unitId: room.id, date: '2026-10-13', start: 540, end: 600, resourceUnit: room },
  bookingModule: 'spacebooking',
  activeView: 'map',
  units: [room],
  floorId: '5150',
  employees: [{ id: '7', name: 'Niviya', department: 'Design' }],
  bookBy: '7',
  bookingsNonce: 0,
};

// One set of actions for the whole file, so a test can read back what the form called.
const acts = vi.hoisted(() => ({ showToast: (() => {}) as (...a: unknown[]) => void, submitBooking: (() => {}) as (...a: unknown[]) => unknown, closeBookingForm: (() => {}) as () => void }));

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state, actions: acts }),
}));

vi.mock('../../state/selectors', () => ({
  unitById: (_s: unknown, id: string) => (id === room.id ? room : null),
  mergeWithOrgPool: (units: Unit[]) => units,
  isBookable: () => true,
}));

vi.mock('../../lib/facilioApi', () => ({ isFacilioApiConfigured: true }));

vi.mock('../../hooks/useOrgClock', () => ({ useOrgClock: () => ({ dateISO: '2026-10-13', minutes: 480 }) }));

vi.mock('../../lib/facilioApiDataSource', () => ({
  fetchOrgBookableResources: vi.fn(async () => [room]),
  fetchBookingFormList: vi.fn(async () => [formSummary]),
  fetchBookingFormById: vi.fn(async () => formMeta),
  fetchOrgBookingsForRange: vi.fn(async () => []),
  resolveFormResourceTypes: vi.fn(async () => new Map([[7, 'room']])),
  pickDefaultBookingForm: () => formSummary,
  bookingFormsForType: () => [formSummary],
}));

import { BookingModal } from './BookingModal';
import * as orgData from '../../lib/facilioApiDataSource';

beforeEach(() => {
  acts.showToast = vi.fn();
  acts.submitBooking = vi.fn();
  acts.closeBookingForm = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('BookingModal with a loaded form', () => {
  it('renders once the form fields land, instead of throwing on the resource field', async () => {
    // A TDZ ReferenceError thrown in render propagates out of `render`/`waitFor`, so reaching the
    // assertions below IS the assertion that it no longer throws.
    render(<BookingModal />);

    // Wait for a field that exists ONLY once the form's metadata has landed — the resource lookup
    // alone renders from the picked unit on the very first paint, before the crash condition holds.
    await waitFor(() => expect(screen.getByText('Purpose')).toBeTruthy());
    // The form's own resource field, rendered from its `rooms` lookup.
    expect(screen.getByText('Location')).toBeTruthy();
    expect(screen.getByText('Meeting Room 2')).toBeTruthy();
  });
});

describe('BookingModal while it saves, and for a screen reader', () => {
  it('cannot be closed while the booking is being made — Escape and the X do nothing', async () => {
    // The window opens at 09:00 on 13 October; "now" is the day before, so the start is ahead.
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 12));
    acts.submitBooking = vi.fn(() => new Promise(() => {})); // still saving
    render(<BookingModal />);
    await waitFor(() => expect(screen.getByText('Purpose')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Submit Details' }));
    await waitFor(() => expect(acts.submitBooking).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /Saving/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(acts.closeBookingForm).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('comes off hold when the save throws — Submit works again, the failure is said, and Escape closes', async () => {
    // Close is a no-op while submitting, and a throw used to skip `setSubmitting(false)`: the form
    // could then never be closed until the page was reloaded.
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 12));
    acts.submitBooking = vi.fn(() => Promise.reject(new Error('network down')));
    render(<BookingModal />);
    await waitFor(() => expect(screen.getByText('Purpose')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Submit Details' }));
    await waitFor(() => expect(acts.submitBooking).toHaveBeenCalledTimes(1));
    const submit = (await screen.findByRole('button', { name: 'Submit Details' })) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(acts.showToast).toHaveBeenCalledWith(expect.stringContaining('network down'));
    expect(acts.closeBookingForm).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(acts.closeBookingForm).toHaveBeenCalledTimes(1);
  });

  it('lets go of the hold after a minute without an answer, says so, and then closes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 12));
    acts.submitBooking = vi.fn(() => new Promise(() => {})); // never answers
    const timers = vi.spyOn(globalThis, 'setTimeout');
    render(<BookingModal />);
    await waitFor(() => expect(screen.getByText('Purpose')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Submit Details' }));
    await waitFor(() => expect(acts.submitBooking).toHaveBeenCalledTimes(1));
    const hold = timers.mock.calls.find(([, ms]) => ms === 60_000);
    expect(hold).toBeTruthy();
    timers.mockRestore();
    await act(async () => (hold![0] as () => void)());

    const submit = (await screen.findByRole('button', { name: 'Submit Details' })) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(acts.showToast).toHaveBeenCalledWith(expect.stringContaining('not been confirmed yet'));
    expect(acts.closeBookingForm).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(acts.closeBookingForm).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape as before when nothing is being saved', async () => {
    render(<BookingModal />);
    await waitFor(() => expect(screen.getByText('Purpose')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(acts.closeBookingForm).toHaveBeenCalledTimes(1);
  });

  it('ties each text field to its label, so it is announced by name', async () => {
    render(<BookingModal />);
    const purpose = await screen.findByLabelText('Purpose');
    expect(purpose.tagName).toBe('INPUT');
  });

  it('names a lookup it cannot show in the console once per form, not on every keystroke', async () => {
    vi.mocked(orgData.fetchBookingFormById).mockResolvedValueOnce({
      ...formMeta,
      fields: [...formMeta.fields, { name: 'costCentre', label: 'Cost centre', required: false, type: 'LOOKUP_SIMPLE', lookupModule: 'costcentre', sequence: 3 }],
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<BookingModal />);
    const purpose = await screen.findByLabelText('Purpose');
    for (const v of ['a', 'ab', 'abc']) fireEvent.change(purpose, { target: { value: v } });
    const skipped = info.mock.calls.filter((c) => String(c[0]).includes('costCentre'));
    expect(skipped.length).toBe(1);
  });
});

describe('the clash line', () => {
  it('reads the resource’s bookings strictly, and shows the clashes a part-way read did find — saying there may be others', async () => {
    const { IncompleteListError } = await import('../../lib/rateLimit');
    vi.mocked(orgData.fetchOrgBookingsForRange).mockRejectedValue(
      new IncompleteListError([{ id: '1', unitId: room.id, date: '2026-10-13', start: 540, end: 570, by: '9' }], true, 'page 2 refused'),
    );
    render(<BookingModal />);
    const line = await screen.findByText(/Already booked/, {}, { timeout: 2000 });
    expect(line.textContent).toContain('09:00');
    expect(line.textContent).toContain('Some bookings could not be loaded');
    expect(orgData.fetchOrgBookingsForRange).toHaveBeenCalledWith('2026-10-13', '2026-10-13', expect.objectContaining({ strict: true, resourceIds: [room.id] }));
  });

  it('says the bookings could not all be loaded when a part-way read found no clash', async () => {
    const { RateLimitedError } = await import('../../lib/rateLimit');
    vi.mocked(orgData.fetchOrgBookingsForRange).mockRejectedValue(new RateLimitedError('refused'));
    render(<BookingModal />);
    expect(await screen.findByText(/Some bookings could not be loaded — this time may already be taken/, {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText(/Already booked/)).toBeNull();
  });
});
