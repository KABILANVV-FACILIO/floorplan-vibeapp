/**
 * Which marker labels can actually be drawn without landing on top of something else.
 *
 * Markers and their labels are counter-scaled by 1/z, so they keep a constant SIZE on screen
 * while their POSITIONS scale with the zoom. Zoom out on a dense floor and a bank of desks that
 * is comfortably spaced at 100% becomes a pile: every chip keeps its 24px, the gaps between them
 * shrink to nothing, and each label is drawn over its neighbour's marker and its neighbour's
 * label. The result is unreadable in exactly the places that matter most — the crowded ones.
 *
 * The zoom threshold the canvas already had (`invZ <= 1.9`) is a blunt version of this: it drops
 * every label past one zoom level whether or not there was room, and keeps every label before it
 * whether or not there was. Spacing is a property of the plan, not of the zoom — two desks 4cm
 * apart collide at a zoom where a sparse floor is perfectly legible.
 *
 * So: lay the labels out and keep the ones that fit. A label is kept only if it clears every
 * marker chip and every label already kept; ties go to the labels that matter most (the selected
 * record, then "Your desk"), because the one thing worse than a dropped label is dropping the
 * one the user is looking at.
 *
 * Pure geometry — no DOM, no React — so the rules can be pinned by tests rather than by eye.
 */

export interface MarkerLabelInput {
  id: string;
  /** Normalized position on the plan (0..1), the same coordinates units are stored in. */
  x: number;
  y: number;
  /** The chip's on-screen size in px (constant across zoom). */
  size: number;
  /** Text of the label ABOVE the chip, or null when it has none. */
  name?: string | null;
  /** Text of the label BELOW the chip (the holder's name), or null. */
  sub?: string | null;
  /** The label above is the wider "Your desk" pill rather than a plain name. */
  pill?: boolean;
  /**
   * Placement order — lower goes first and therefore wins a collision. The selected record and
   * the user's own desk come first; everything else shares the last rank and is ordered by
   * position so the result is stable between renders.
   */
  rank: number;
  /**
   * Draw the label above no matter what it lands on. Only the "Your desk" pill asks for this: it
   * is the answer to "where do I sit", and a decluttering pass that can hide it has removed a
   * feature rather than tidied a plan. It still reserves its space, so everything else yields.
   */
  must?: boolean;
}

export interface LabelPlacement {
  /** The desk's name, ABOVE its chip — or the "Your desk" pill, which takes that place. */
  name: boolean;
  /** "Holder · Department", BELOW the chip. Never drawn without `name`. */
  sub: boolean;
  /**
   * How wide the holder line may run, in px, when it is drawn. Usually SUB_MAX_PX or the text's
   * own width; narrower when that is what it took to fit beside a neighbour's. The markup caps
   * the line at exactly this, so what is drawn is what was reserved.
   */
  subWidth?: number;
}

export interface LabelLayoutOptions {
  /** The plan's intrinsic pixel size — normalized coordinates multiply up by these. */
  planW: number;
  planH: number;
  /** Current zoom. Screen distance between two markers is their plan distance times this. */
  zoom: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gap between a chip and its label, and the breathing room demanded between two labels. */
const GAP = 4;
const PAD = 1;

/**
 * Width of a rendered label, in px.
 *
 * An estimate, deliberately: measuring means a canvas context (absent in tests) or a layout pass
 * per label per frame, to decide something that only has to be right to within a few px. Roboto's
 * average advance at these weights is ~0.55em; the constant covers the 5px side padding and the
 * 1px border.
 */
export function estimateLabelWidth(text: string, fontPx: number): number {
  return Math.round(text.length * fontPx * 0.55) + 12;
}

/** Height of a rendered label, in px — line box plus padding plus border. */
export function labelHeight(fontPx: number): number {
  return Math.round(fontPx * 1.1) + 6;
}

const NAME_FONT = 8.5;
const SUB_FONT = 8;

/**
 * The longest a label may run on screen before its text ends in "…". Shared with the markup
 * (Marker.tsx) so the layout reserves exactly the box that gets drawn. The full text is never
 * lost: it is on the chip's own hover tooltip.
 */
export const NAME_MAX_PX = 96;
export const SUB_MAX_PX = 120;
/**
 * Where a holder line stops narrowing to make room. Below this the ellipsis leaves too little of
 * the name to recognise ("Amrithya · P…" still reads; "Amr…" does not), and the desk shows its
 * name alone instead.
 */
const SUB_MIN_PX = 68;
/** The narrower widths tried, widest first, when the holder line does not fit at its own. */
const SUB_NARROWER_PX = [100, 84, SUB_MIN_PX];
/** The "Your desk" pill carries an icon and more generous padding than a plain name label. */
const PILL_EXTRA = 26;
const PILL_HEIGHT = 20;

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + PAD && b.x < a.x + a.w + PAD && a.y < b.y + b.h + PAD && b.y < a.y + a.h + PAD;
}

/**
 * A uniform grid over the boxes already placed, so each candidate is only tested against what is
 * near it. A floor can carry a thousand markers and this runs on every zoom change.
 */
class BoxGrid {
  private cells = new Map<string, Box[]>();
  constructor(private cell: number) {}

  private keysFor(b: Box): string[] {
    const keys: string[] = [];
    const x0 = Math.floor((b.x - PAD) / this.cell);
    const x1 = Math.floor((b.x + b.w + PAD) / this.cell);
    const y0 = Math.floor((b.y - PAD) / this.cell);
    const y1 = Math.floor((b.y + b.h + PAD) / this.cell);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) keys.push(`${cx}:${cy}`);
    return keys;
  }

  add(b: Box): void {
    for (const k of this.keysFor(b)) {
      const cell = this.cells.get(k);
      if (cell) cell.push(b);
      else this.cells.set(k, [b]);
    }
  }

  hits(b: Box): boolean {
    for (const k of this.keysFor(b)) {
      const cell = this.cells.get(k);
      if (!cell) continue;
      for (const other of cell) if (overlaps(b, other)) return true;
    }
    return false;
  }
}

/**
 * Decide which labels to draw. Returns a placement per marker id; a marker missing from the map
 * has no label to draw at all.
 *
 * Every chip is reserved first — chips are always drawn, so a label may never cover one, not even
 * the label of a higher-ranked marker. Labels are then placed in rank order into whatever space
 * is left.
 */
export function planMarkerLabels(inputs: MarkerLabelInput[], opts: LabelLayoutOptions): Map<string, LabelPlacement> {
  const out = new Map<string, LabelPlacement>();
  if (inputs.length === 0) return out;

  const { planW, planH, zoom } = opts;
  const screen = (i: MarkerLabelInput) => ({ cx: i.x * planW * zoom, cy: i.y * planH * zoom });

  // Cell size tracks the biggest thing being placed, so a box spans few cells.
  const grid = new BoxGrid(64);
  for (const i of inputs) {
    const { cx, cy } = screen(i);
    grid.add({ x: cx - i.size / 2, y: cy - i.size / 2, w: i.size, h: i.size });
  }

  const order = [...inputs].sort((a, b) => a.rank - b.rank || a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));

  for (const i of order) {
    const { cx, cy } = screen(i);
    const half = i.size / 2;
    const placement: LabelPlacement = { name: false, sub: false };

    /*
     * The desk's name ABOVE its chip, and who holds it (with their department) BELOW.
     *
     * The name decides. If it does not fit, the desk shows neither line: a holder line on its own
     * under a chip is what once left a block of desks captioned by one desk's number above and a
     * different desk's holder below, the two survivors reading as a title and caption for the
     * whole group. So a holder line is never drawn without its own desk's name above it.
     *
     * The holder line then takes the widest width that fits — its own (capped at SUB_MAX_PX),
     * then narrower, down to SUB_MIN_PX, ending in "…". In a row of desks a little closer than
     * two full holder lines, the second desk used to lose BOTH lines because its holder overlapped
     * its neighbour's by a few px; now it keeps its name and a shorter holder. Only when not even
     * the narrowest fits does the desk show its name alone — which is how a free desk reads, and
     * cannot be mistaken for anyone else's caption. The full text is on the chip's tooltip.
     *
     * Widths are the capped ones the markup actually draws: measuring the full text would reserve
     * room the ellipsis never uses, and drop labels in a dense block for no reason.
     */
    const nameBox = i.name
      ? (() => {
          const h = i.pill ? PILL_HEIGHT : labelHeight(NAME_FONT);
          const w = i.pill
            ? estimateLabelWidth(i.name, NAME_FONT) + PILL_EXTRA
            : Math.min(estimateLabelWidth(i.name, NAME_FONT), NAME_MAX_PX);
          return { x: cx - w / 2, y: cy - half - GAP - h, w, h };
        })()
      : null;

    // The "Your desk" pill draws whatever it lands on — it is the answer to "where do I sit".
    // Everything else needs its name to fit.
    const nameFits = !!nameBox && (i.must || !grid.hits(nameBox));
    if (nameFits && nameBox) {
      grid.add(nameBox);
      placement.name = true;

      if (i.sub) {
        const own = Math.min(estimateLabelWidth(i.sub, SUB_FONT), SUB_MAX_PX);
        const widths = [own, ...SUB_NARROWER_PX.filter((w) => w < own)];
        const h = labelHeight(SUB_FONT);
        for (const w of widths) {
          const subBox = { x: cx - w / 2, y: cy + half + GAP, w, h };
          if (grid.hits(subBox)) continue;
          grid.add(subBox);
          placement.sub = true;
          placement.subWidth = w;
          break;
        }
      }
    }

    out.set(i.id, placement);
  }

  return out;
}
