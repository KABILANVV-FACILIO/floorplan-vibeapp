import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Settings › First responders named the first three people in each role and hid the rest behind a
 * hover-only "+N others" — out of reach from a keyboard or a touch screen — and every name kept its
 * employee number ("251850 - Johar Ali"). New in v77.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions: {} }) }));
// Nothing here searches the directory; the tab's people search reaches the org's data source.
vi.mock('../../hooks/useLivePeople', () => ({ useLivePeople: () => ({ people: [], loading: false, failed: false }) }));

const { FirstRespondersTab } = await import('./FirstRespondersTab');

const firstAider = { id: 'firstAider', name: 'First aider', plural: 'First aiders', color: '#29A01E', icon: 'cross', shape: 'square', builtIn: true };
const names = ['251850 - Johar Ali', '251851 - Omar Al Marri', '251852 - Priya Nair', '251853 - Sara Khan', '251854 - Lee Wong'];

afterEach(cleanup);

function show() {
  ctx.state = {
    responderRoles: [firstAider],
    firstResponders: names.map((name, i) => ({ employeeId: String(1000 + i), name, roles: ['firstAider'] })),
    employees: [],
  };
  return render(<FirstRespondersTab />);
}

describe('the responder summary', () => {
  it('shows names without their employee numbers', () => {
    show();
    expect(screen.getByText(/Johar Ali, Omar Al Marri, Priya Nair/)).toBeTruthy();
    expect(screen.queryByText(/251850/)).toBeNull();
  });

  it('makes "+2 others" a button that names all five, without codes', () => {
    show();
    const more = screen.getByRole('button', { name: /^\+2 others/ });
    expect(more.tagName).toBe('BUTTON');
    const label = more.getAttribute('aria-label') ?? '';
    for (const n of ['Johar Ali', 'Omar Al Marri', 'Priya Nair', 'Sara Khan', 'Lee Wong']) expect(label).toContain(n);
    expect(label).not.toMatch(/\d{6}/);
    expect(more.getAttribute('data-tip')).toBe('Johar Ali, Omar Al Marri, Priya Nair, Sara Khan, Lee Wong');
  });

  it('spells the whole list out when pressed — the way in from touch and the keyboard', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /^\+2 others/ }));
    expect(screen.getByText('Johar Ali, Omar Al Marri, Priya Nair, Sara Khan, Lee Wong')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /others/ })).toBeNull();
  });
});
