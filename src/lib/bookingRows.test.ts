import { describe, expect, it } from 'vitest';
import { bookingSegmentsFromRow, cancelledStateIdOf, clipSegmentsToRange } from './bookingRows';
import { epochAtInTz } from './orgTime';

/**
 * A spacebooking row from the org → the calendar's bookings. What matters: a booking that runs
 * past midnight is one record but one segment per day, cancelled rows hold no slot, and the day a
 * row lands on is decided by the ORG's clock, not the browser's.
 */

const TZ = 'Asia/Dubai';
const at = (date: string, minutes: number) => epochAtInTz(date, minutes, TZ);

describe('bookingSegmentsFromRow', () => {
  it('files a same-day booking on its day, on the org clock', () => {
    const segs = bookingSegmentsFromRow({ id: 7, desk: { id: 41 }, bookingStartTime: at('2026-10-05', 9 * 60), bookingEndTime: at('2026-10-05', 11 * 60), reservedBy: { id: 3 }, name: 'Standup' }, TZ);
    expect(segs).toEqual([
      expect.objectContaining({ id: '7', unitId: '41', date: '2026-10-05', start: 540, end: 660, by: '3', name: 'Standup', purpose: 'Standup', approvalPending: false }),
    ]);
    expect(segs![0].segCount).toBeUndefined();
  });

  it('splits a booking that runs past midnight into one segment per day, all with the same id', () => {
    const segs = bookingSegmentsFromRow({ id: 8, desk: { id: 41 }, bookingStartTime: at('2026-10-05', 17 * 60 + 30), bookingEndTime: at('2026-10-08', 17 * 60 + 30) }, TZ)!;
    expect(segs.map((s) => [s.date, s.start, s.end, s.segIndex, s.segCount])).toEqual([
      ['2026-10-05', 1050, 1440, 0, 4],
      ['2026-10-06', 0, 1440, 1, 4],
      ['2026-10-07', 0, 1440, 2, 4],
      ['2026-10-08', 0, 1050, 3, 4],
    ]);
    expect(new Set(segs.map((s) => s.id))).toEqual(new Set(['8']));
  });

  it('keeps a booking that ends exactly at midnight on its own day', () => {
    const segs = bookingSegmentsFromRow({ id: 9, space: { id: 5 }, bookingStartTime: at('2026-10-05', 22 * 60), bookingEndTime: at('2026-10-06', 0) }, TZ)!;
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ date: '2026-10-05', start: 1320, end: 1440, unitId: '5' });
  });

  it('drops a cancelled row — the flag first, then a dead state name', () => {
    const live = { id: 1, desk: { id: 2 }, bookingStartTime: at('2026-10-05', 600), bookingEndTime: at('2026-10-05', 660) };
    expect(bookingSegmentsFromRow({ ...live, isCancelled: true }, TZ)).toBeNull();
    expect(bookingSegmentsFromRow({ ...live, isCancelled: 'true' }, TZ)).toBeNull();
    expect(bookingSegmentsFromRow({ ...live, moduleState: { id: 4060, displayName: 'Rejected' } }, TZ)).toBeNull();
    expect(bookingSegmentsFromRow({ ...live, moduleState: { id: 12, displayName: 'Confirmed' } }, TZ)).not.toBeNull();
  });

  it('drops a row with no resource or no start', () => {
    expect(bookingSegmentsFromRow({ id: 1, bookingStartTime: at('2026-10-05', 600) }, TZ)).toBeNull();
    expect(bookingSegmentsFromRow({ id: 1, desk: { id: 2 } }, TZ)).toBeNull();
  });

  it('marks a booking pending only under a real approval flow', () => {
    const live = { id: 1, desk: { id: 2 }, bookingStartTime: at('2026-10-05', 600), bookingEndTime: at('2026-10-05', 660) };
    expect(bookingSegmentsFromRow({ ...live, approvalFlowId: -1, approvalStatus: -1 }, TZ)![0].approvalPending).toBe(false);
    expect(bookingSegmentsFromRow({ ...live, approvalFlowId: 3, approvalStatus: { displayName: 'Pending' } }, TZ)![0].approvalPending).toBe(true);
    expect(bookingSegmentsFromRow({ ...live, approvalFlowId: 3, approvalStatus: { displayName: 'Approved' } }, TZ)![0].approvalPending).toBe(false);
  });
});

describe('clipSegmentsToRange', () => {
  it('keeps the days inside the range of a booking that started before it', () => {
    const segs = bookingSegmentsFromRow({ id: 5, desk: { id: 1 }, bookingStartTime: at('2026-10-03', 600), bookingEndTime: at('2026-10-09', 600) }, TZ)!;
    const kept = clipSegmentsToRange(segs, '2026-10-05', '2026-10-07');
    expect(kept.map((s) => s.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    // Still the same record, still marked as a middle of a longer booking.
    expect(kept.every((s) => s.id === '5' && s.segCount === 7)).toBe(true);
    expect(kept[0]).toMatchObject({ start: 0, end: 1440, segIndex: 2 });
  });
});

describe('cancelledStateIdOf', () => {
  it('learns the id of a cancelled state from a row in it, and nothing from a live row', () => {
    expect(cancelledStateIdOf({ id: 1, moduleState: { id: 4060, displayName: 'Cancelled' } })).toBe('4060');
    expect(cancelledStateIdOf({ id: 1, isCancelled: true, moduleState: { id: 77, displayName: 'Closed' } })).toBe('77');
    expect(cancelledStateIdOf({ id: 1, moduleState: { id: 12, displayName: 'Confirmed' } })).toBeNull();
    expect(cancelledStateIdOf({ id: 1, isCancelled: true })).toBeNull();
  });
});
