import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Unit } from '../../lib/types';

/**
 * The phone's QR scanner (v77 review): closed while the camera's video was still starting, it went
 * on to start its scan timer with nothing left to stop it; and the timer matched codes against the
 * floor as it was when the scanner opened, so a code scanned once the floor's spaces had arrived
 * found nothing.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const actions = { openBookingForm: vi.fn(), showToast: vi.fn(), setMobSel: vi.fn() };
vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));

const { MobileQrScanner } = await import('./MobileQrScanner');

const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-07', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan: 'workstation', deskType: 'HOT' };

let detected: string | null = null;
let play: { resolve: () => void } | null = null;
const stop = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  detected = null;
  ctx.state = { units: [], enabledModules: { workstation: true }, planViews: { book: true, assign: true }, date: '2026-11-24', start: 540, end: 600 };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: () => new Promise<void>((r) => (play = { resolve: r })),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
  (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
    detect = vi.fn(async () => (detected ? [{ rawValue: detected }] : []));
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
});

/** Let the camera's promises settle. */
const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

describe('the camera scan loop', () => {
  it('never starts when the scanner is closed before the video plays', async () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    const { unmount } = render(<MobileQrScanner onClose={vi.fn()} />);
    await settle();
    expect(play).not.toBeNull();
    unmount();
    await act(async () => {
      play!.resolve();
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(setInterval).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    setInterval.mockRestore();
  });

  it('matches a code against the floor as it is now, not as it was when the scanner opened', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<MobileQrScanner onClose={onClose} />);
    await settle();
    await act(async () => {
      play!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    // The floor's spaces arrive while the scanner is open.
    ctx.state = { ...ctx.state, units: [desk] };
    rerender(<MobileQrScanner onClose={onClose} />);
    detected = 'WS-07';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(actions.openBookingForm).toHaveBeenCalledWith(expect.objectContaining({ unitId: '1001' }));
    expect(onClose).toHaveBeenCalled();
  });
});
