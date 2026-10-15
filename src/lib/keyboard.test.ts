// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { activateOnKey, planShortcutAllowed } from './keyboard';

afterEach(() => {
  document.body.innerHTML = '';
});

function keyEvent(key: string, target: EventTarget, currentTarget: EventTarget = target) {
  return { key, target, currentTarget, preventDefault: vi.fn() } as unknown as ReactKeyboardEvent;
}

describe('activateOnKey', () => {
  it('activates on Enter and on Space, and keeps Space from scrolling', () => {
    const el = document.createElement('div');
    const fn = vi.fn();
    const enter = keyEvent('Enter', el);
    const space = keyEvent(' ', el);
    activateOnKey(fn)(enter);
    activateOnKey(fn)(space);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(space.preventDefault).toHaveBeenCalled();
  });

  it('ignores every other key', () => {
    const el = document.createElement('div');
    const fn = vi.fn();
    activateOnKey(fn)(keyEvent('a', el));
    activateOnKey(fn)(keyEvent('Tab', el));
    expect(fn).not.toHaveBeenCalled();
  });

  it('leaves Enter on a button inside the row to that button', () => {
    const row = document.createElement('div');
    const inner = document.createElement('button');
    row.appendChild(inner);
    const fn = vi.fn();
    activateOnKey(fn)(keyEvent('Enter', inner, row));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('planShortcutAllowed', () => {
  function setup() {
    const plan = document.createElement('div');
    const marker = document.createElement('div');
    plan.appendChild(marker);
    const button = document.createElement('button');
    const input = document.createElement('input');
    document.body.append(plan, button, input);
    return { plan, marker, button, input };
  }

  it('allows the plan itself, a marker on it, and nothing focused', () => {
    const { plan, marker } = setup();
    expect(planShortcutAllowed(plan, plan)).toBe(true);
    expect(planShortcutAllowed(marker, plan)).toBe(true);
    expect(planShortcutAllowed(document.body, plan)).toBe(true);
    expect(planShortcutAllowed(null, plan)).toBe(true);
  });

  it('refuses a focused button or a text field outside the plan', () => {
    const { plan, button, input } = setup();
    expect(planShortcutAllowed(button, plan)).toBe(false);
    expect(planShortcutAllowed(input, plan)).toBe(false);
  });

  it('refuses everything while a dialog is open, even on the plan', () => {
    const { plan, marker } = setup();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    expect(planShortcutAllowed(marker, plan)).toBe(false);
    expect(planShortcutAllowed(document.body, plan)).toBe(false);
  });
});
