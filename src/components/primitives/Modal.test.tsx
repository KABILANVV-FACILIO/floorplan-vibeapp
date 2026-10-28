import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Modal, ModalHeader } from './Modal';

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

describe('Modal works from the keyboard', () => {
  it('moves the focus into the dialog, and gives it back to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <ModalHeader title="Pick" onClose={() => {}} />
        <button>First</button>
      </Modal>
    );
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('gives the focus back to the opener even when a field inside took it on open', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <Modal onClose={() => {}}>
        <button autoFocus>Cancel</button>
      </Modal>
    );
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('leaves the focus on a field that took it itself', () => {
    render(
      <Modal onClose={() => {}}>
        <button>Close</button>
        <input aria-label="Name" autoFocus />
      </Modal>
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('is named after its header', () => {
    render(
      <Modal onClose={() => {}}>
        <ModalHeader title="Upload floorplan" onClose={() => {}} />
      </Modal>
    );
    expect(screen.getByRole('dialog', { name: 'Upload floorplan' })).toBeTruthy();
  });

  it('closes on Escape, and the key goes no further', () => {
    const onClose = vi.fn();
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    render(
      <Modal onClose={onClose}>
        <button>Ok</button>
      </Modal>
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener('keydown', behind);
  });

  it('closes only the innermost dialog on Escape', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Modal onClose={outer}>
          <button>Outer</button>
        </Modal>
        <Modal onClose={inner}>
          <button>Inner</button>
        </Modal>
      </>
    );
    fireEvent.keyDown(screen.getByText('Inner'), { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', () => {
    render(
      <Modal onClose={() => {}}>
        <button>First</button>
        <button>Last</button>
      </Modal>
    );
    const first = screen.getByText('First');
    const last = screen.getByText('Last');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('skips a field taken out of the tab order', () => {
    render(
      <Modal onClose={() => {}}>
        <button>First</button>
        <button>Last</button>
        <input type="file" tabIndex={-1} aria-label="file" />
      </Modal>
    );
    const last = screen.getByText('Last');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('First'));
  });
});
