import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installTooltipLayer } from './tooltipLayer';

/**
 * The hover tooltips were missing from this app entirely — no layer, no `data-tip` anywhere — so
 * every hint that wasn't a native browser `title` simply never appeared. These assert the two
 * properties that make the ported layer worth having: the bubble lives OUTSIDE the anchor (so no
 * scroll container can clip it), and it is driven by `data-tip` on any element.
 *
 * Fixtures are appended and removed rather than assigned through `body.innerHTML`, which would
 * detach the layer's own bubble — it is created lazily on first show and then reused.
 */

const DELAY = 250; // the layer opens after 200ms

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}
function hover(el: Element) {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}
function unhover(el: Element) {
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
}
const bubble = () => document.querySelector<HTMLElement>('.fp-tip');
const showing = () => !!bubble()?.classList.contains('fp-tip-on');

beforeAll(() => {
  installTooltipLayer();
});

describe('hover tooltip layer', () => {
  let host: HTMLElement | null = null;
  afterEach(() => {
    host?.remove();
    host = null;
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // closes the bubble
    vi.useRealTimers();
  });

  it('shows the text from data-tip after the open delay', () => {
    vi.useFakeTimers();
    host = mount('<button data-tip="Locate my desk">x</button>');
    const btn = host.querySelector('button')!;

    hover(btn);
    expect(showing()).toBe(false); // nothing on hover alone — it waits

    vi.advanceTimersByTime(DELAY);
    expect(bubble()!.textContent).toBe('Locate my desk');
    expect(showing()).toBe(true);
  });

  it('puts the bubble under <body>, not inside the anchor', () => {
    vi.useFakeTimers();
    // The whole point: a bubble rendered inside its anchor is clipped by any scrolling ancestor,
    // which is how a tree's own tooltips end up sliced in half.
    host = mount('<div style="overflow:auto"><span data-tip="Site A">s</span></div>');
    hover(host.querySelector('span')!);
    vi.advanceTimersByTime(DELAY);

    const tip = bubble()!;
    expect(tip.parentElement).toBe(document.body);
    expect(host.contains(tip)).toBe(false);
    // Positioned in viewport coordinates by the layer itself, not by the anchor's box.
    expect(tip.style.top).not.toBe('');
    expect(tip.style.left).not.toBe('');
  });

  it('hides again when the pointer leaves', () => {
    vi.useFakeTimers();
    host = mount('<button data-tip="Collapse">x</button>');
    const btn = host.querySelector('button')!;
    hover(btn);
    vi.advanceTimersByTime(DELAY);
    expect(showing()).toBe(true);

    unhover(btn);
    expect(showing()).toBe(false);
  });

  it('never opens for an element with no data-tip', () => {
    vi.useFakeTimers();
    host = mount('<button>x</button>');
    hover(host.querySelector('button')!);
    vi.advanceTimersByTime(DELAY);
    expect(showing()).toBe(false);
  });

  it('treats an empty data-tip as "suppressed"', () => {
    vi.useFakeTimers();
    host = mount('<button data-tip="">x</button>');
    hover(host.querySelector('button')!);
    vi.advanceTimersByTime(DELAY);
    expect(showing()).toBe(false);
  });

  it('reads data-tip off an ancestor when the pointer lands on a child', () => {
    vi.useFakeTimers();
    // Buttons wrap icons, so the mouseover target is usually the <svg>, not the button.
    host = mount('<button data-tip="Edit floorplan"><svg><circle /></svg></button>');
    hover(host.querySelector('circle')!);
    vi.advanceTimersByTime(DELAY);
    expect(bubble()!.textContent).toBe('Edit floorplan');
  });

  it('opens on keyboard focus too, not only the mouse', () => {
    vi.useFakeTimers();
    host = mount('<button data-tip="Save changes">x</button>');
    host.querySelector('button')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(DELAY);
    expect(bubble()!.textContent).toBe('Save changes');
  });

  it('closes on scroll — the anchor can leave its container', () => {
    vi.useFakeTimers();
    host = mount('<button data-tip="Reset layout">x</button>');
    hover(host.querySelector('button')!);
    vi.advanceTimersByTime(DELAY);
    expect(showing()).toBe(true);

    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(showing()).toBe(false);
  });

  it('keeps exactly one bubble however many times it is installed', () => {
    vi.useFakeTimers();
    installTooltipLayer();
    installTooltipLayer();
    host = mount('<button data-tip="One">x</button>');
    hover(host.querySelector('button')!);
    vi.advanceTimersByTime(DELAY);
    expect(document.querySelectorAll('.fp-tip')).toHaveLength(1);
  });
});
