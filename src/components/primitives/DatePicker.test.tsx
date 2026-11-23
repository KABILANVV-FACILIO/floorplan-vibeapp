import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Modal, ModalHeader } from './Modal';
import { DatePicker } from './DatePicker';
import { Picklist } from '../fds/Picklist';

vi.mock('../../lib/orgTime', () => ({ orgNow: () => ({ dateISO: '2026-11-20', minutes: 600 }) }));

/**
 * The booking form's date and time fields open a picker portalled to <body> — outside the dialog
 * they sit in — and the focus was never moved into it, so the dialog's Tab trap could not reach it
 * and a keyboard user could not pick a date at all.
 */
afterEach(cleanup);

function InDialog({ onClose, minutes }: { onClose: () => void; minutes?: boolean }) {
  const [value, setValue] = useState('2026-11-24');
  const [mins, setMins] = useState(540);
  return (
    <Modal onClose={onClose}>
      <ModalHeader title="Space Booking" onClose={onClose} />
      <DatePicker
        value={value}
        onChange={setValue}
        min="2026-11-20"
        {...(minutes ? { minutes: mins, onMinutesChange: setMins, minuteStep: 30 } : {})}
        aria-label="Start time"
      />
      <button type="button">After</button>
    </Modal>
  );
}

describe('the date picker inside a dialog, from the keyboard', () => {
  it('puts the focus on the selected day as it opens, in a pop-up named as a dialog', () => {
    render(<InDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start time' }));
    const pop = screen.getByRole('dialog', { name: 'Choose start time' });
    expect(pop.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).getAttribute('aria-pressed')).toBe('true');
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toContain('24');
  });

  it('falls back to the first day that can be picked when the selected one cannot', () => {
    function Past() {
      return (
        <Modal onClose={() => {}}>
          <ModalHeader title="T" onClose={() => {}} />
          <DatePicker value="2026-11-02" onChange={() => {}} min="2026-11-20" aria-label="Date" />
        </Modal>
      );
    }
    render(<Past />);
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    const active = document.activeElement as HTMLButtonElement;
    expect(active.disabled).toBe(false);
    expect(active.dataset.day).toBe('2026-11-20');
  });

  it('closes on Escape and hands the focus back to the field — the dialog stays open', () => {
    const onClose = vi.fn();
    render(<InDialog onClose={onClose} />);
    const field = screen.getByRole('button', { name: 'Start time' });
    fireEvent.click(field);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Choose start time' })).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Space Booking' })).toBeTruthy();
  });

  it('picks a day without closing the dialog, and returns the focus to the field', () => {
    const onClose = vi.fn();
    render(<InDialog onClose={onClose} />);
    const field = screen.getByRole('button', { name: 'Start time' });
    fireEvent.click(field);
    const pop = screen.getByRole('dialog', { name: 'Choose start time' });
    const day = pop.querySelector<HTMLButtonElement>('[data-day="2026-11-26"]')!;
    fireEvent.mouseDown(day);
    fireEvent.click(day);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Choose start time' })).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.textContent).toMatch(/26/);
  });

  it('keeps Tab inside the pop-up, and the arrow keys walk the days', () => {
    render(<InDialog onClose={() => {}} minutes />);
    fireEvent.click(screen.getByRole('button', { name: 'Start time' }));
    const pop = screen.getByRole('dialog', { name: 'Choose start time' });
    const start = document.activeElement as HTMLElement;
    expect(start.dataset.day).toBe('2026-11-24');

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect((document.activeElement as HTMLElement).dataset.day).toBe('2026-11-25');
    // A week up is the 18th, before the earliest day that can be booked: the focus stays put.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect((document.activeElement as HTMLElement).dataset.day).toBe('2026-11-25');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect((document.activeElement as HTMLElement).dataset.day).toBe('2026-11-24');

    const buttons = [...pop.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    expect(pop.contains(document.activeElement)).toBe(true);
  });
});

describe('the FDS picklist from the keyboard', () => {
  const options = [
    { value: 'ASSIGNED', label: 'Assigned' },
    { value: 'HOT', label: 'Hot desk' },
    { value: 'HOTEL', label: 'Hotel desk' },
  ];

  it('opens on Arrow Down onto the chosen option, and the arrows move between options', () => {
    render(<Picklist value="HOT" options={options} onChange={() => {}} aria-label="Desk type" />);
    const trigger = screen.getByRole('button', { name: 'Desk type' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Hot desk' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Hotel desk' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Assigned' }));
  });

  it('closes on Escape, back on the field, without the key reaching the plan behind it', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      render(<Picklist value="HOT" options={options} onChange={() => {}} aria-label="Desk type" />);
      const trigger = screen.getByRole('button', { name: 'Desk type' });
      fireEvent.click(trigger);
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('picks with a click as before, and hands the focus back', () => {
    const onChange = vi.fn();
    render(<Picklist value="HOT" options={options} onChange={onChange} aria-label="Desk type" />);
    const trigger = screen.getByRole('button', { name: 'Desk type' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Assigned' }));
    expect(onChange).toHaveBeenCalledWith('ASSIGNED');
    expect(document.activeElement).toBe(trigger);
  });
});
