import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Modal } from './Modal';

/**
 * A `position: fixed` backdrop resolves against the nearest TRANSFORMED ancestor, not the viewport.
 * The unit popover is a 214px card carrying `transform: translate(-50%, 0)`, so a dialog opened
 * from inside it was laid out within that card — a 640px picker rendered at about 330px with every
 * name truncated. The portal is what prevents that, so it is what these assert.
 */
afterEach(cleanup);

describe('Modal escapes whatever it was opened from', () => {
  it('mounts on <body>, not inside its React parent', () => {
    const { container } = render(
      <div style={{ transform: 'translate(-50%, 0)', width: 214 }}>
        <Modal onClose={() => {}}>
          <p>Pick someone</p>
        </Modal>
      </div>
    );

    const dialog = screen.getByText('Pick someone');
    expect(container.contains(dialog)).toBe(false);
    // Walk up from the dialog: nothing between it and <body> may carry a transform.
    let el: HTMLElement | null = dialog.parentElement;
    let sawBody = false;
    while (el) {
      if (el === document.body) {
        sawBody = true;
        break;
      }
      expect(el.style.transform).toBe('');
      el = el.parentElement;
    }
    expect(sawBody).toBe(true);
  });

  it('keeps the width it was given', () => {
    render(
      <Modal onClose={() => {}} width={640}>
        <p>Wide</p>
      </Modal>
    );
    const card = screen.getByText('Wide').parentElement!;
    expect(card.style.width).toBe('640px');
  });

  it('closes on the backdrop but not on the card itself', () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    const card = screen.getByText('Body').parentElement!;
    const backdrop = card.parentElement!;

    card.click();
    expect(onClose).not.toHaveBeenCalled();

    backdrop.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cleans itself off <body> when unmounted', () => {
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <p>Transient</p>
      </Modal>
    );
    expect(screen.queryByText('Transient')).not.toBeNull();
    unmount();
    expect(screen.queryByText('Transient')).toBeNull();
  });
});
