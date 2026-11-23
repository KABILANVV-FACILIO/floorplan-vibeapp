import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { departmentColor } from '../../lib/departmentColors';

/**
 * Changing two or more departments' colours and pressing Save kept only one of them (v77 review):
 * each change was its own save of the whole scheme, built from the colours before the Save. Save now
 * hands every change to the store in one call, which saves the scheme once.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const actions = { setColorBy: vi.fn(), setDepartmentColor: vi.fn(), setDepartmentColors: vi.fn() };
vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));
vi.mock('../../hooks/useLivePeople', () => ({ useLivePeople: () => ({ people: [], loading: false, failed: false, loadFailed: false, retry: () => {} }) }));

const { DepartmentColorsModal } = await import('./SettingsScreen');

afterEach(cleanup);

describe('Settings › Colour desks by', () => {
  it('saves two changed department colours in one call, holding both', () => {
    const departments = [
      { id: '10', name: 'Finance' },
      { id: '20', name: 'Engineering' },
      { id: '30', name: 'Legal' },
    ];
    ctx.state = { departments, units: [], departmentColors: {}, colorBy: 'status' };
    const ids = departments.map((d) => d.id);
    // Two colours neither department has by default.
    const pick = (id: string, not: string[]) => ['#b0006e', '#0d9aa8', '#5c7a1e', '#e07b00'].find((hex) => hex !== departmentColor(id, {}, ids) && !not.includes(hex))!;
    const finance = pick('10', []);
    const engineering = pick('20', [finance]);
    render(<DepartmentColorsModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: `Finance colour ${finance}` }));
    fireEvent.click(screen.getByRole('button', { name: `Engineering colour ${engineering}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(actions.setDepartmentColors).toHaveBeenCalledTimes(1);
    expect(actions.setDepartmentColors).toHaveBeenCalledWith({ '10': { hex: finance, name: 'Finance' }, '20': { hex: engineering, name: 'Engineering' } });
    expect(actions.setDepartmentColor).not.toHaveBeenCalled();
  });
});
