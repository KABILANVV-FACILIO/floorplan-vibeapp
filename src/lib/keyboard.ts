import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Enter and Space activate a focused element that acts as a button but isn't one (a tree row, a
 * list row, a marker on the plan, a drop zone) — what a real <button> does for free.
 *
 * Only when the element ITSELF has the focus: a row can hold its own buttons, and Enter on one of
 * those is that button's business, not the row's.
 */
export function activateOnKey(onActivate: (e: ReactKeyboardEvent) => void) {
  return (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Space would otherwise scroll the panel the row sits in.
    e.preventDefault();
    onActivate(e);
  };
}

const EDITABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/**
 * May a plan shortcut (Delete, Enter, V) act on this key press?
 *
 * Only when the key lands on the plan itself or on nothing in particular. Anywhere else the key
 * belongs to what has the focus: text typed into a field, a button that was just clicked, a
 * dialog that is open. Listening on the window and skipping text fields alone let Backspace on a
 * focused button, or inside an open dialog, delete the selected desk.
 */
export function planShortcutAllowed(target: EventTarget | null, plan: Element | null, doc: Document = document): boolean {
  // Any open dialog owns the keyboard, wherever the focus happens to be.
  if (doc.querySelector('[aria-modal="true"]')) return false;
  const el = target instanceof Element ? target : null;
  if (!el || el === doc.body || el === doc.documentElement) return true;
  if (EDITABLE_TAGS.has(el.tagName) || (el as HTMLElement).isContentEditable) return false;
  return !!plan && plan.contains(el);
}
