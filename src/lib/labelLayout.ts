/**
 * Which marker labels can actually be drawn without landing on top of something else — and where.
 *
 * Markers and their labels are counter-scaled by 1/z, so they keep a constant SIZE on screen
 * while their POSITIONS scale with the zoom. Zoom out on a dense floor and a bank of desks that
 * is comfortably spaced at 100% becomes a pile: every chip keeps its 24px, the gaps between them
 * shrink to nothing, and each label is drawn over its neighbour's marker and its neighbour's
 * label. The result is unreadable in exactly the places that matter most — the crowded ones.
 *
 * So: lay the labels out and keep the ones that fit. Each desk gets ONE card — its name, who
 * holds it, their department — placed at the best of eight spots around its chip (below, above,
 * right, left, the corners); a card that fits nowhere is tried with fewer lines and narrower,
 * down to the desk's name alone. A card is kept only if it clears every chip and every card
 * already kept; ties go to the labels that matter most (the selected record, then "Your desk"),
 * because the one thing worse than a dropped label is dropping the one the user is looking at.
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
  /** The desk's name — the card's first line. No name, no card. */
  name?: string | null;
  /** Who holds it — the second line, or null. */
  sub?: string | null;
  /** Their department — the third line (two, when it is long), or null. */
  dept?: string | null;
  /** The "Your desk" pill stands above the chip as well as the card. */
  pill?: boolean;
  /**
   * Placement order — lower goes first and therefore wins a collision. The selected record and
   * the user's own desk come first; everything else shares the last rank and is ordered by
   * position so the result is stable between renders.
   */
  rank: number;
  /**
   * Draw the pill no matter what it lands on. Only "Your desk" asks for this: it is the answer
   * to "where do I sit", and a decluttering pass that can hide it has removed a feature rather
   * than tidied a plan. It still reserves its space, so everything else yields.
   */
  must?: boolean;
  /**
   * The text widths in px, measured in the page's font (see lib/textMeasure). Estimated from the
   * character count when absent.
   */
  nameW?: number;
  subW?: number;
  deptW?: number;
}

/**
 * Where a card sits relative to its chip: in line with its row or its column, never on a corner.
 * A corner card sat between two chips and read as either's — "which one is WS-05?" — so a card
 * is always centred on its own chip's row or column, and points at it (see Marker).
 */
export type LabelPos = 'below' | 'above' | 'right' | 'left';

export interface LabelPlacement {
  /** The card is drawn (it always carries the desk's name). */
  name: boolean;
  /** The card carries the holder. Never without `name`. */
  sub: boolean;
  /** The card carries the department. Never without `sub`. */
  dept?: boolean;
  /** The "Your desk" pill is drawn above the chip. */
  pill?: boolean;
  /** Where the card sits, and its exact size in px — the markup draws exactly this box. */
  pos?: LabelPos;
  w?: number;
  h?: number;
  /** The department runs to two lines. */
  deptLines?: 1 | 2;
}

export interface LabelLayoutOptions {
  /** The plan's intrinsic pixel size — normalized coordinates multiply up by these. */
  planW: number;
  planH: number;
  /** Current zoom. Screen distance between two markers is their plan distance times this. */
  zoom: number;
  /**
   * The last plan. A card keeps the spot it had while it still fits there — growing in place as
   * the zoom makes room — and is only placed afresh when it no longer does. Without this every
   * zoom step re-decided every card from scratch, and on a dense floor most of them hopped to
   * another side of their chip at every step of the wheel.
   */
  previous?: Map<string, LabelPlacement>;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gap between a chip and its card — the card's pointer sits in it — and the breathing room demanded between two cards. */
export const CARD_GAP = 5;
const GAP = CARD_GAP;
const PAD = 1;
/** How near a placed neighbour has to be for a card to take the same side as it. */
const COHERENCE_PX = 90;

/** The card's type: the name, the holder, the department. Line heights are fixed so the layout's box is the drawn box. */
export const NAME_FONT = 8.5;
export const SUB_FONT = 8;
export const DEPT_FONT = 7.5;
export const NAME_WEIGHT = 600;
export const SUB_WEIGHT = 500;
export const DEPT_WEIGHT = 400;
export const NAME_LINE_PX = 10;
export const SUB_LINE_PX = 10;
export const DEPT_LINE_PX = 9;
/** The card's padding (3px above and below, 5px each side) and 1px border. */
export const CARD_PAD_Y = 3;
export const CARD_PAD_X = 5;
const CARD_EXTRA_W = 2 * CARD_PAD_X + 2;
const CARD_EXTRA_H = 2 * CARD_PAD_Y + 2;

/**
 * The widest a card may be. Wider than the old 120px line, so a holder's full name and most
 * departments fit on one line where there is room; where there isn't, the card narrows.
 */
export const CARD_MAX_PX = 180;
/** Narrower widths tried, widest first, when a card does not fit at its own. */
const FULL_NARROWER_PX = [140, 110];
const NAME_SUB_NARROWER_PX = [100];
const NAME_NARROWER_PX = [84];
/** Characters a holder line holds at CARD_MAX_PX — past this a name is shortened to first + last. */
export const SUB_MAX_CHARS = Math.floor((CARD_MAX_PX - CARD_EXTRA_W) / (SUB_FONT * 0.55));
/** The "Your desk" pill carries an icon and more generous padding than a plain label. */
const PILL_EXTRA = 26;
const PILL_HEIGHT = 20;
const PILL_TEXT = 'Your desk';

/**
 * Width of a run of text, in px — an estimate when it was not measured.
 *
 * Roboto's average advance at these weights is ~0.55em. Measured widths (lib/textMeasure) come
 * with the inputs wherever there is a canvas; the estimate is what tests and a server see.
 */
export function estimateTextWidth(text: string, fontPx: number): number {
  return Math.round(text.length * fontPx * 0.55);
}

/** Width of a rendered one-line label, in px: its text plus the padding and border. */
export function estimateLabelWidth(text: string, fontPx: number): number {
  return estimateTextWidth(text, fontPx) + CARD_EXTRA_W;
}

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
 * Where a card's top-left corner sits relative to its chip's centre, in screen px, for a
 * placement. Shared with the markup, so the card is drawn exactly where it was reserved.
 */
export function cardOffset(pos: LabelPos, w: number, h: number, half: number): { dx: number; dy: number } {
  switch (pos) {
    case 'below':
      return { dx: -w / 2, dy: half + GAP };
    case 'above':
      return { dx: -w / 2, dy: -half - GAP - h };
    case 'right':
      return { dx: half + GAP, dy: -h / 2 };
    case 'left':
      return { dx: -half - GAP - w, dy: -h / 2 };
  }
}

/** Below first for a desk with a holder (the holder reads under the desk); above first for a bare name, as a free desk always read. */
const WITH_HOLDER: LabelPos[] = ['below', 'above', 'right', 'left'];
const NAME_ONLY: LabelPos[] = ['above', 'below', 'right', 'left'];

/**
 * The cards placed so far, by where their chips are, so a card can take the side its nearest
 * placed neighbour took: a bank of desks then carries its cards in one line (all below, or all to
 * the right) instead of each desk choosing for itself and the bank reading as a scatter.
 */
class PlacedSides {
  private cells = new Map<string, { cx: number; cy: number; pos: LabelPos }[]>();
  constructor(private cell: number) {}
  add(cx: number, cy: number, pos: LabelPos): void {
    const k = `${Math.floor(cx / this.cell)}:${Math.floor(cy / this.cell)}`;
    const cell = this.cells.get(k);
    if (cell) cell.push({ cx, cy, pos });
    else this.cells.set(k, [{ cx, cy, pos }]);
  }
  /** The side of the nearest card placed within COHERENCE_PX, if any. */
  nearest(cx: number, cy: number): LabelPos | null {
    const x0 = Math.floor((cx - COHERENCE_PX) / this.cell);
    const x1 = Math.floor((cx + COHERENCE_PX) / this.cell);
    const y0 = Math.floor((cy - COHERENCE_PX) / this.cell);
    const y1 = Math.floor((cy + COHERENCE_PX) / this.cell);
    let best: LabelPos | null = null;
    let bestD = COHERENCE_PX;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const cell = this.cells.get(`${x}:${y}`);
        if (!cell) continue;
        for (const p of cell) {
          const d = Math.hypot(p.cx - cx, p.cy - cy);
          if (d < bestD) {
            bestD = d;
            best = p.pos;
          }
        }
      }
    return best;
  }
}

/** The card's height for its lines. */
export function cardHeight(sub: boolean, deptLines: 0 | 1 | 2): number {
  return CARD_EXTRA_H + NAME_LINE_PX + (sub ? SUB_LINE_PX : 0) + deptLines * DEPT_LINE_PX;
}

/**
 * Decide which labels to draw, and where. Returns a placement per marker id; a marker missing
 * from the map has no label to draw at all.
 *
 * Every chip is reserved first — chips are always drawn, so a label may never cover one, not even
 * the label of a higher-ranked marker. Cards are then placed in rank order into whatever space
 * is left: the whole card at its own width first, then narrower, then with fewer lines, each at
 * every position around the chip, and the first that fits wins.
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
  const sides = new PlacedSides(COHERENCE_PX);

  for (const i of order) {
    const { cx, cy } = screen(i);
    const half = i.size / 2;
    const placement: LabelPlacement = { name: false, sub: false };

    // The "Your desk" pill draws whatever it lands on — it is the answer to "where do I sit".
    if (i.pill) {
      const w = estimateLabelWidth(PILL_TEXT, NAME_FONT) + PILL_EXTRA;
      const box = { x: cx - w / 2, y: cy - half - GAP - PILL_HEIGHT, w, h: PILL_HEIGHT };
      if (i.must || !grid.hits(box)) {
        grid.add(box);
        placement.pill = true;
      }
    }

    if (i.name) {
      const nameW = i.nameW ?? estimateTextWidth(i.name, NAME_FONT);
      const subW = i.sub ? (i.subW ?? estimateTextWidth(i.sub, SUB_FONT)) : 0;
      const deptW = i.dept ? (i.deptW ?? estimateTextWidth(i.dept, DEPT_FONT)) : 0;

      // What the card may carry, most first; for each, its own width then narrower ones.
      type Variant = { sub: boolean; dept: boolean; widths: number[] };
      const widthsFor = (natural: number, narrower: number[]) => {
        const own = Math.min(natural + CARD_EXTRA_W, CARD_MAX_PX);
        return [own, ...narrower.filter((n) => n < own)];
      };
      const variants: Variant[] = [];
      if (i.sub && i.dept) variants.push({ sub: true, dept: true, widths: widthsFor(Math.max(nameW, subW, deptW), FULL_NARROWER_PX) });
      if (i.sub) variants.push({ sub: true, dept: false, widths: widthsFor(Math.max(nameW, subW), NAME_SUB_NARROWER_PX) });
      variants.push({ sub: false, dept: false, widths: widthsFor(nameW, NAME_NARROWER_PX) });
      // Its last spot first, if it had one; then the side its nearest placed neighbour took; then
      // the usual order.
      const prev = opts.previous?.get(i.id);
      const kept = prev?.name && prev.pos ? prev.pos : null;
      const near = sides.nearest(cx, cy);
      const usual = i.sub ? WITH_HOLDER : NAME_ONLY;
      const positions: LabelPos[] = [];
      for (const p of [kept, near, ...usual]) if (p && !positions.includes(p)) positions.push(p);

      search: for (const v of variants) {
        for (const w of v.widths) {
          // A department wider than the card runs to a second line rather than ending in "…".
          const deptLines: 0 | 1 | 2 = v.dept ? (deptW > w - CARD_EXTRA_W ? 2 : 1) : 0;
          const h = cardHeight(v.sub, deptLines);
          for (const pos of positions) {
            // The pill stands above the chip: a card never goes there too.
            if (placement.pill && pos === 'above') continue;
            const { dx, dy } = cardOffset(pos, w, h, half);
            const box = { x: cx + dx, y: cy + dy, w, h };
            if (grid.hits(box)) continue;
            grid.add(box);
            placement.name = true;
            placement.sub = v.sub;
            placement.dept = v.dept;
            placement.pos = pos;
            placement.w = w;
            placement.h = h;
            if (v.dept) placement.deptLines = deptLines as 1 | 2;
            sides.add(cx, cy, pos);
            break search;
          }
        }
      }
    }

    out.set(i.id, placement);
  }

  return out;
}

/**
 * Room names, the same way: which ones can be drawn without landing on another.
 *
 * A room's name is drawn at its outline's centroid at a constant screen size (RoomLabel: 600 11px,
 * 3px 8px padding, one line), while the outline itself scales with the zoom. With the org's own
 * outlines now on the plan — every onboarded floor has dozens, many of them toilets, stores and
 * janitor rooms a few metres wide, named like "HQ-BKB-1F-Male Toilet" — nearly every name at a
 * fit-to-screen zoom is wider than its room, and neighbouring names pile into one unreadable block
 * of white boxes. So a name is drawn only when it fits inside its room's on-screen bounds AND
 * clears every name already kept; a room whose name doesn't fit shows its outline alone, and its
 * name once selected (its card, and its label, which a selected room always keeps) or zoomed in
 * far enough for it to fit.
 *
 * Bigger rooms go first — the larger the room, the more its name orients the reader — but the
 * selected room's name always shows (`must`): it is the one the user is looking at, and editing
 * a room whose name vanished would be editing blind.
 */
export interface RoomLabelInput {
  id: string;
  /** The outline, in normalized (0..1) plan coordinates. */
  pts: [number, number][];
  /** Where the name is drawn (the centroid RoomLabel uses), normalized. */
  x: number;
  y: number;
  name: string;
  /** Draw it whatever it covers — the selected room. It still reserves its space. */
  must?: boolean;
  /** Height of the line under the name (the area in Edit, "Available" in Book), in px; 0 for none. */
  subHeight?: number;
}

/** RoomLabel's type: 600 11px, with 8px side padding and a 1px border — wider than a marker's. */
const ROOM_FONT = 11;
export function estimateRoomLabelWidth(text: string): number {
  return Math.round(text.length * ROOM_FONT * 0.6) + 18;
}
/** Its height: the 11px line box (line-height 1), 3px padding top and bottom, and the border. */
const ROOM_LABEL_H = ROOM_FONT + 8;

export function planRoomLabels(inputs: RoomLabelInput[], opts: LabelLayoutOptions): Set<string> {
  const out = new Set<string>();
  if (inputs.length === 0) return out;
  const { planW, planH, zoom } = opts;
  const sized = inputs.map((i) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of i.pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const roomW = (x1 - x0) * planW * zoom;
    const roomH = (y1 - y0) * planH * zoom;
    const w = estimateRoomLabelWidth(i.name);
    const h = ROOM_LABEL_H + (i.subHeight ? i.subHeight + 2 : 0);
    const cx = i.x * planW * zoom;
    const cy = i.y * planH * zoom;
    return { i, area: roomW * roomH, fits: w <= roomW && ROOM_LABEL_H <= roomH, box: { x: cx - w / 2, y: cy - h / 2, w, h } };
  });
  const order = sized.sort((a, b) => Number(!!b.i.must) - Number(!!a.i.must) || b.area - a.area || (a.i.id < b.i.id ? -1 : 1));
  const grid = new BoxGrid(128);
  for (const s of order) {
    if (!s.i.must && (!s.fits || grid.hits(s.box))) continue;
    grid.add(s.box);
    out.add(s.i.id);
  }
  return out;
}
