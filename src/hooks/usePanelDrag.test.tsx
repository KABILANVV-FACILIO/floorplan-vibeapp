import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * A floating panel's drag listened on the window until the mouse came up. Inside the Facilio frame
 * a release outside it never arrives, so a panel that went away mid-drag kept being moved by every
 * later mouse move.
 */

const setPanelPos = vi.fn();
vi.mock('../state/FloorplanContext', () => ({
  useFloorplanData: () => ({
    state: { panels: { portfolio: { open: true } }, stage: { w: 1200, h: 800 } },
    actions: { panelPos: () => ({ x: 10, y: 10 }), setPanelPos, togglePanelOpen: vi.fn() },
  }),
}));

const { usePanelDrag } = await import('./usePanelDrag');

function Panel() {
  const drag = usePanelDrag('portfolio', 300);
  return <div data-testid="head" onMouseDown={drag.onHeaderDown} />;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a floating panel drag', () => {
  it('moves the panel while the mouse is down, and stops on release', () => {
    render(<Panel />);
    fireEvent.mouseDown(screen.getByTestId('head'), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 140, clientY: 120 });
    expect(setPanelPos).toHaveBeenCalledWith('portfolio', 50, 30, 300);
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 300, clientY: 300 });
    expect(setPanelPos).toHaveBeenCalledTimes(1);
  });

  it('lets go of the window when the panel goes mid-drag', () => {
    const { unmount } = render(<Panel />);
    fireEvent.mouseDown(screen.getByTestId('head'), { button: 0, clientX: 100, clientY: 100 });
    unmount();
    fireEvent.mouseMove(window, { clientX: 140, clientY: 120 });
    fireEvent.mouseUp(window);
    expect(setPanelPos).not.toHaveBeenCalled();
  });
});
