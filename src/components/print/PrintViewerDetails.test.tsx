import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_PLAN_LABELS, DEFAULT_REGISTER_PRINTS } from '../../lib/types';

/**
 * The print window's settings choose what the plan's page shows and the registers after it — offered
 * on every plan, a tab per kind on it; the window itself zooms its pages.
 */

const ctx = vi.hoisted(() => ({ planId: 'parking' as string, setPrintScope: (() => {}) as (v: string) => void }));

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({
    state: { planId: ctx.planId, floorId: 'f1', portfolio: [], printScope: 'floor', printRegisters: DEFAULT_REGISTER_PRINTS, planLabels: DEFAULT_PLAN_LABELS },
    actions: { setPrintScope: (v: string) => ctx.setPrintScope(v), setPrintRegister: vi.fn() },
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
  it('offers Print settings on every plan', () => {
    for (const plan of ['parking', 'workstation', 'locker']) {
      ctx.planId = plan;
      render(<PrintViewer onClose={() => {}} />);
      expect(screen.getByRole('button', { name: 'Print settings' })).toBeTruthy();
      cleanup();
    }
  });

  it('opens on a tab per register the plan prints: desks and rooms after a desk plan', () => {
    ctx.planId = 'workstation';
    render(<PrintViewer onClose={() => {}} />);
    screen.getByRole('button', { name: 'Print settings' }).click();
    return Promise.resolve().then(() => {
      expect(screen.getByRole('tab', { name: /Desk/ })).toBeTruthy();
      expect(screen.getByRole('tab', { name: /Room/ })).toBeTruthy();
    });
  });

  it('opens on the parking register alone after a parking plan, with no tabs', () => {
    ctx.planId = 'parking';
    render(<PrintViewer onClose={() => {}} />);
    screen.getByRole('button', { name: 'Print settings' }).click();
    return Promise.resolve().then(() => {
      expect(screen.queryByRole('tab')).toBeNull();
      expect(screen.getByRole('switch', { name: 'Parking register' })).toBeTruthy();
    });
  });

  it('keeps the plan choice in Print settings, not the footer: Floor + details, staged until Apply', () => {
    ctx.planId = 'workstation';
    const picked: string[] = [];
    ctx.setPrintScope = (v) => picked.push(v);
    render(<PrintViewer onClose={() => {}} />);
    expect(screen.queryByRole('group', { name: /Plan/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Print settings' }));
    const plan = screen.getByRole('radiogroup', { name: 'Plan' });
    expect(plan.querySelector('[aria-checked="true"]')?.textContent).toBe('Whole floor'); // the state's choice
    fireEvent.click(screen.getByRole('radio', { name: 'Floor + details' }));
    expect(picked).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(picked).toEqual(['detail']);
  });

  it('zooms the pages out and in, and back to the fitted page', () => {
    render(<PrintViewer onClose={() => {}} />);
    // jsdom lays nothing out, so the page fits at its least, 10%.
    const pct = () => screen.getByRole('button', { name: /fit the page/ }).textContent;
    expect(pct()).toBe('10%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(pct()).toBe('13%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(pct()).toBe('8%');
    fireEvent.click(screen.getByRole('button', { name: /fit the page/ }));
    expect(pct()).toBe('10%');
  });

  it('zooms on a trackpad pinch (a wheel with Ctrl held) and leaves a plain scroll alone', () => {
    const { container } = render(<PrintViewer onClose={() => {}} />);
    const area = container.ownerDocument.querySelector('[class*="area"]') as HTMLElement;
    const pct = () => screen.getByRole('button', { name: /fit the page/ }).textContent;
    act(() => {
      area.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    });
    expect(pct()).toBe('10%');
    const pinch = new WheelEvent('wheel', { deltaY: -30, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      area.dispatchEvent(pinch);
    });
    expect(pinch.defaultPrevented).toBe(true);
    expect(pct()).toBe('13%');
  });
});
