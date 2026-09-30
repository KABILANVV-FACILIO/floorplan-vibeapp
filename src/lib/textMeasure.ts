/**
 * The width of a label's text in the page's own font, measured on a canvas — for the label
 * layout, which reserves exactly the box the label draws.
 *
 * Estimated from the character count (0.55em each), a desk name with room to spare still ended
 * in "…" whenever its letters ran wider than the average, and a narrow one reserved room it never
 * used. Texts don't change with the zoom, so each distinct string is measured once and kept.
 * Where there is no canvas (tests, a server) the measurer is undefined and the layout estimates.
 */
export type LabelTextMeasure = (text: string, fontPx: number, weight: number) => number;

let shared: LabelTextMeasure | undefined | null = null;
/** The page's one measurer, made on first use — the canvas and the print sheet share its cache. */
export function sharedLabelTextMeasurer(): LabelTextMeasure | undefined {
  if (shared === null) shared = labelTextMeasurer();
  return shared;
}

export function labelTextMeasurer(): LabelTextMeasure | undefined {
  if (typeof document === 'undefined') return undefined;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return undefined;
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif';
  const cache = new Map<string, number>();
  return (text, fontPx, weight) => {
    const key = `${weight}|${fontPx}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = `${weight} ${fontPx}px ${family}`;
    // A touch over the measurement: the page lays text out with hinting the canvas doesn't.
    const w = Math.ceil(ctx.measureText(text).width * 1.03);
    cache.set(key, w);
    return w;
  };
}
