import { afterEach, describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, whose pdf.js worker import the runner can't resolve.
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { BOOK_DAY_END, BOOK_DAY_START, slotNow } from './orgTime';
import { buildInitialState, reducer } from '../state/reducer';

/**
 * The booking window the app opens on (ENEC, 2026-11-16): the slot the org's clock is in now, not a
 * fixed 10:00–11:00 — so a desk counted "booked" is booked now.
 */

const hm = (h: number, m = 0) => h * 60 + m;

describe('slotNow', () => {
  it('opens on the 30-minute slot now falls in', () => {
    expect(slotNow(hm(14, 20), 30)).toEqual({ start: hm(14), end: hm(14, 30) });
    expect(slotNow(hm(14, 30), 30)).toEqual({ start: hm(14, 30), end: hm(15) });
    expect(slotNow(hm(9, 59), 30)).toEqual({ start: hm(9, 30), end: hm(10) });
  });

  it('is one booking slot long, rounded up to the pickers’ 30-minute steps', () => {
    expect(slotNow(hm(14, 20), 60)).toEqual({ start: hm(14), end: hm(15) });
    expect(slotNow(hm(14, 20), 45)).toEqual({ start: hm(14), end: hm(15) });
    expect(slotNow(hm(14, 20), 15)).toEqual({ start: hm(14), end: hm(14, 30) });
  });

  it('keeps to the bookable day: its first slot before 07:00, its last after', () => {
    expect(slotNow(hm(0, 5), 30)).toEqual({ start: BOOK_DAY_START, end: BOOK_DAY_START + 30 });
    expect(slotNow(hm(6, 59), 30)).toEqual({ start: hm(7), end: hm(7, 30) });
    expect(slotNow(hm(21, 40), 30)).toEqual({ start: hm(19, 30), end: BOOK_DAY_END });
    expect(slotNow(hm(19, 40), 60)).toEqual({ start: hm(19), end: BOOK_DAY_END });
  });
});

describe('the window the app opens on', () => {
  afterEach(() => vi.useRealTimers());

  it('starts on the slot the device clock is in, before the org’s timezone is known', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 16, 14, 20), toFake: ['Date'] });
    expect(buildInitialState()).toMatchObject({ start: hm(14), end: hm(14, 30) });
  });

  it('moves to the org clock’s slot once the timezone is in, one booking slot long', () => {
    const s = { ...buildInitialState(), slotGranularity: 60 };
    expect(reducer(s, { type: 'SET_WINDOW_NOW', minutes: hm(11, 10) })).toMatchObject({ start: hm(11), end: hm(12) });
  });
});
