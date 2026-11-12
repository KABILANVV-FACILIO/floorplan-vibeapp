import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_PARKING_PRINT, DEFAULT_PLAN_LABELS } from '../../lib/types';

/** The print window's Details is the parking register's — offered on a parking plan only. */

const ctx = vi.hoisted(() => ({ planId: 'parking' as string }));

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({
    state: { planId: ctx.planId, floorId: 'f1', portfolio: [], printScope: 'floor', parkingPrint: DEFAULT_PARKING_PRINT, planLabels: DEFAULT_PLAN_LABELS },
    actions: { setPrintScope: vi.fn(), setParkingPrint: vi.fn() },
  }),
}));
// The sheet itself draws the plan with the canvas's components; nothing here needs them.
vi.mock('./PrintSheet', () => ({ PrintSheet: () => null, printFileName: () => 'plan.pdf' }));
vi.mock('./useParkingRegister', () => ({
  useParkingRegister: () => ({ stalls: [], labelField: null, ctx: { planLabel: () => '', labelField: null, holderOf: () => null, personById: () => null, location: '' } }),
}));

const { PrintViewer } = await import('./PrintViewer');

beforeAll(() => {
  // jsdom has no ResizeObserver; the viewer only uses it to fit the page.
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe('the print window', () => {
  it('offers Details on a parking plan', () => {
    ctx.planId = 'parking';
    render(<PrintViewer onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
  });

  it('prints desks and lockers as before, with no Details', () => {
    for (const plan of ['workstation', 'locker']) {
      ctx.planId = plan;
      render(<PrintViewer onClose={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
      cleanup();
    }
  });
});
