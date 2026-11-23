import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_ENABLED_MODULES } from '../../lib/types';

/**
 * R7: Settings › Modules switches any of the five modules off, but never the last one — an app with
 * every module hidden is a blank plan with no way back from the plan itself. The rule lives in the
 * Modules window (the reducer turns off whatever it is told to), so it is pinned here, through the
 * screen as an admin uses it.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const actions = { setModuleEnabled: vi.fn(), setSettingsTab: vi.fn(), openMap: vi.fn() };
vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));
vi.mock('../../hooks/useLivePeople', () => ({ useLivePeople: () => ({ people: [], loading: false, failed: false, loadFailed: false, retry: () => {} }) }));

const { SettingsScreen } = await import('./SettingsScreen');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openModules(enabled: Record<string, boolean>) {
  ctx.state = { settingsTab: 'modules', enabledModules: { ...DEFAULT_ENABLED_MODULES, ...enabled } };
  render(<SettingsScreen />);
  fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
  return screen.getByRole('dialog');
}

describe('Settings › Modules', () => {
  it('switches modules off until one is left, and refuses the last', () => {
    const dialog = openModules({});
    for (const name of ['Room', 'Locker', 'Parking stall', 'Delivery area']) fireEvent.click(within(dialog).getByRole('button', { name }));
    const desks = within(dialog).getByRole('button', { name: 'Desk' });
    fireEvent.click(desks);
    expect(desks.getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('status').textContent).toBe('Desk is the only module left. Turn another on before hiding it.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(actions.setModuleEnabled).toHaveBeenCalledTimes(4);
    expect(actions.setModuleEnabled.mock.calls.map(([m, on]) => [m, on])).toEqual([
      ['room', false],
      ['locker', false],
      ['parking', false],
      ['delivery', false],
    ]);
  });

  it('refuses the one module an org already runs alone', () => {
    const dialog = openModules({ workstation: false, room: false, locker: false, delivery: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Parking stall' }));
    expect(within(dialog).getByRole('status').textContent).toMatch(/Parking stall is the only module left/);
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
  });
});
