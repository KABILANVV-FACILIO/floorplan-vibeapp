import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_PLAN_LABELS, DEFAULT_REGISTER_PRINTS } from '../../lib/types';

/** The print window's Details chooses the registers after the plan — offered on every plan, a tab per kind on it. */

const ctx = vi.hoisted(() => ({ planId: 'parking' as string }));

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({
    state: { planId: ctx.planId, floorId: 'f1', portfolio: [], printScope: 'floor', printRegisters: DEFAULT_REGISTER_PRINTS, planLabels: DEFAULT_PLAN_LABELS },
    actions: { setPrintScope: vi.fn(), setPrintRegister: vi.fn() },
  }),
}));
// The sheet itself draws the plan with the canvas's components; nothing here needs them.
vi.mock('./PrintSheet', () => ({ PrintSheet: () => null, printFileName: () => 'plan.pdf' }));
vi.mock('./useRegister', () => ({
  useRegister: (_s: unknown, kind: string) => ({ kind, units: [], labelField: null, ctx: { planLabel: () => '', labelField: null, holderOf: () => null, personById: () => null, location: '' } }),
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
  it('offers Details on every plan', () => {
    for (const plan of ['parking', 'workstation', 'locker']) {
      ctx.planId = plan;
      render(<PrintViewer onClose={() => {}} />);
      expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
      cleanup();
    }
  });

  it('opens on a tab per register the plan prints: desks and rooms after a desk plan', () => {
    ctx.planId = 'workstation';
    render(<PrintViewer onClose={() => {}} />);
    screen.getByRole('button', { name: 'Details' }).click();
    return Promise.resolve().then(() => {
      expect(screen.getByRole('tab', { name: /Desk/ })).toBeTruthy();
      expect(screen.getByRole('tab', { name: /Room/ })).toBeTruthy();
    });
  });

  it('opens on the parking register alone after a parking plan, with no tabs', () => {
    ctx.planId = 'parking';
    render(<PrintViewer onClose={() => {}} />);
    screen.getByRole('button', { name: 'Details' }).click();
    return Promise.resolve().then(() => {
      expect(screen.queryByRole('tab')).toBeNull();
      expect(screen.getByRole('switch', { name: 'Parking register' })).toBeTruthy();
    });
  });
});
