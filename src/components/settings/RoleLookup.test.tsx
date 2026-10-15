import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OrgRole, SurfaceAccess } from '../../lib/types';

/**
 * The role field in Configure access behaves like Facilio's FSelect: its list FLOATS over the
 * modal rather than opening inside the row, and it closes on a click elsewhere, on Escape, or when
 * focus leaves it.
 */

vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: {}, actions: {} }) }));

const { RoleLookup } = await import('./SettingsScreen');

const ROLES: OrgRole[] = [
  { id: '3873', name: 'CAFM Super Administrator', isAdmin: true },
  { id: '4215', name: 'ENEC Executive' },
];

function setup(rule: SurfaceAccess = { all: true, roles: [] }, roles = ROLES) {
  const handlers = { onToggleAll: vi.fn(), onToggleRole: vi.fn(), onClear: vi.fn() };
  const utils = render(
    <div data-testid="row">
      <RoleLookup label="Bookings" rule={rule} roles={roles} loading={false} locked={[]} {...handlers} />
    </div>
  );
  const field = screen.getByRole('button', { name: 'Roles that can reach Bookings' });
  return { ...utils, ...handlers, field };
}

afterEach(cleanup);

describe('the role field', () => {
  it('opens its list OVER the page, not inside the row', () => {
    const { field } = setup();
    fireEvent.click(field);
    const list = screen.getByRole('listbox');
    // Portaled to <body>: the row that holds the field does not contain it.
    expect(screen.getByTestId('row').contains(list)).toBe(false);
    expect(document.body.contains(list)).toBe(true);
  });

  it('closes on a click anywhere else', () => {
    const { field } = setup();
    fireEvent.click(field);
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('stays open for a click inside its own list', () => {
    const { field } = setup({ all: false, roles: [] });
    fireEvent.click(field);
    fireEvent.mouseDown(screen.getByRole('option', { name: /ENEC Executive/ }));
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('closes on Escape', () => {
    const { field } = setup();
    fireEvent.click(field);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes when focus moves somewhere else', () => {
    const { field } = setup();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    fireEvent.click(field);
    fireEvent.focusIn(elsewhere);
    expect(screen.queryByRole('listbox')).toBeNull();
    elsewhere.remove();
  });

  it('will not turn Everyone off when there are no roles to choose instead', () => {
    const { field } = setup({ all: true, roles: [] }, []);
    fireEvent.click(field);
    const everyone = screen.getByRole('option', { name: /Everyone/ }) as HTMLButtonElement;
    expect(everyone.disabled).toBe(true);
  });
});
