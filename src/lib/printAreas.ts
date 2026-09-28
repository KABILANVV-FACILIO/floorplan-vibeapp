/**
 * The print sheet's DETAIL pages: the floor's desks cut into page-sized areas, each printed at a
 * zoom where every desk carries its name above and "Holder · Department" below — the view people
 * zoom the screen to, made for every part of the floor at once instead of only the part on screen.
 *
 * Pure geometry (no DOM, no React) so the cut is pinned by tests:
 *
 *  1. SCALE from the plan itself. Desk spacing differs from plan to plan (a CAD plan at one scale,
 *     an image at another), so a fixed distance would mean nothing. The median distance from each
 *     desk to its nearest neighbour is the plan's own "desk pitch"; the zoom is chosen so that
 *     pitch comes out wide enough on paper for a holder line to sit under each desk.
 *  2. GROUP desks that sit together — any two closer than a few pitches belong to the same group
 *     (a pod, a bank, a row). A gap wider than that is an aisle or a wall, and a sensible place
 *     for one page to end and the next to begin.
 *  3. FIT each group to the page frame at that zoom. A group too big for one page is cut into a
 *     grid of page-sized tiles; small groups near each other share a page, so a floor of 4-desk
 *     pods doesn't print a page per pod.
 *
 * Every desk ends up on exactly one detail page.
 */

export interface DeskPoint {
  id: string;
  /** Position in PLAN pixels (normalized position × plan size). */
  x: number;
  y: number;
}

export interface DetailArea {
  /** The plan point at the centre of the page, in plan pixels. */
  cx: number;
  cy: number;
  zoom: number;
  deskIds: string[];
}

export interface DetailAreaOptions {
  /** The page's plan frame, in CSS px. */
  frameW: number;
  frameH: number;
  /**
   * Zoom in this much further than the plan's own spacing asks for (and past MAX_ZOOM by as much).
   * For a pod whose desks sit closer than the floor's usual pitch — see planLabelledDetailAreas.
   */
  zoomBoost?: number;
}

/** Screen px wanted between neighbouring desks — about one holder line ("Name · Department"). */
const TARGET_PITCH_PX = 115;
const MIN_ZOOM = 0.9;
const MAX_ZOOM = 4;
/** Room inside the frame for the labels of the outermost desks (half a label each side, a line above/below). */
const PAD_X = 75;
const PAD_Y = 45;
/** Desks closer than this many pitches are one group. */
const LINK_PITCHES = 2.6;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function planDetailAreas(points: DeskPoint[], opts: DetailAreaOptions): DetailArea[] {
  if (points.length === 0) return [];
  const pitch = deskPitch(points);
  const boost = opts.zoomBoost ?? 1;
  const zoom = clamp(TARGET_PITCH_PX / pitch, MIN_ZOOM, MAX_ZOOM) * boost;
  // How much plan fits in one page at that zoom, after the label margins.
  const capW = (opts.frameW - 2 * PAD_X) / zoom;
  const capH = (opts.frameH - 2 * PAD_Y) / zoom;

  const groups = linkGroups(points, pitch * LINK_PITCHES).flatMap((g) => splitToFit(g, capW, capH));

  // Reading order, then greedily share pages: a group joins the first page it fits on with.
  groups.sort((a, b) => boxOf(a).minY - boxOf(b).minY || boxOf(a).minX - boxOf(b).minX);
  const pages: DeskPoint[][] = [];
  for (const g of groups) {
    const page = pages.find((p) => fits(boxOf([...p, ...g]), capW, capH));
    if (page) page.push(...g);
    else pages.push([...g]);
  }

  return pages
    .map((p) => {
      const b = boxOf(p);
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      // As close as the page allows, but no more than half again the working zoom, so a page
      // holding one small pod doesn't print it at a size unlike every other page.
      const fitZoom = Math.min(w > 0 ? (opts.frameW - 2 * PAD_X) / w : Infinity, h > 0 ? (opts.frameH - 2 * PAD_Y) / h : Infinity);
      return {
        cx: (b.minX + b.maxX) / 2,
        cy: (b.minY + b.maxY) / 2,
        zoom: Math.min(fitZoom, zoom * 1.5, MAX_ZOOM * boost),
        deskIds: p.map((d) => d.id),
      };
    })
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

/** How far past the plan's own zoom a crowded area may go before it prints as it is. */
const MAX_BOOST = 3.2;
const BOOST_STEP = 1.3;

/**
 * Detail areas in which EVERY desk is labelled in full — the promise each detail page makes
 * ("every desk in this area, with who is placed there").
 *
 * The zoom `planDetailAreas` picks comes from the floor's typical desk spacing, so a pod packed
 * tighter than the rest of the floor (six desks round one table) still prints with neighbouring
 * labels colliding, and the layout drops whichever ones don't fit. So each area is checked with
 * the real label layout (`allLabelled`), and one that fails is cut again, zoomed in further — on
 * more pages if it no longer fits one — until every desk on it is labelled, or the zoom has gone
 * as far as it sensibly can (two desks drawn on top of each other never separate).
 *
 * `labelScale` is how much larger than the screen the pages draw their chips and labels: areas are
 * cut for a frame 1/labelScale the size, and their zoom scaled back up.
 */
export function planLabelledDetailAreas(
  points: DeskPoint[],
  opts: DetailAreaOptions & { labelScale: number; allLabelled: (area: DetailArea) => boolean },
): DetailArea[] {
  const cut = (pts: DeskPoint[], boost: number) =>
    planDetailAreas(pts, { frameW: opts.frameW / opts.labelScale, frameH: opts.frameH / opts.labelScale, zoomBoost: boost }).map((a) => ({
      ...a,
      zoom: a.zoom * opts.labelScale,
    }));
  const byId = new Map(points.map((p) => [p.id, p]));
  const out: DetailArea[] = [];
  const visit = (pts: DeskPoint[], boost: number) => {
    for (const area of cut(pts, boost)) {
      if (boost * BOOST_STEP > MAX_BOOST || opts.allLabelled(area)) out.push(area);
      else visit(area.deskIds.map((id) => byId.get(id)!), boost * BOOST_STEP);
    }
  };
  visit(points, 1);
  return out.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

/** Median nearest-neighbour distance — the plan's own spacing between desks. */
export function deskPitch(points: DeskPoint[]): number {
  if (points.length < 2) return 100;
  const nn = points.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const d = Math.hypot(points[j].x - p.x, points[j].y - p.y);
      if (d > 0 && d < best) best = d;
    }
    return best;
  }).filter(Number.isFinite).sort((a, b) => a - b);
  return nn.length ? nn[Math.floor(nn.length / 2)] : 100;
}

/** Single-linkage groups: desks within `link` of any desk already in a group join it. */
function linkGroups(points: DeskPoint[], link: number): DeskPoint[][] {
  const groupOf = new Array<number>(points.length).fill(-1);
  const groups: DeskPoint[][] = [];
  for (let i = 0; i < points.length; i++) {
    if (groupOf[i] >= 0) continue;
    const g = groups.length;
    groups.push([]);
    const stack = [i];
    groupOf[i] = g;
    while (stack.length) {
      const k = stack.pop()!;
      groups[g].push(points[k]);
      for (let j = 0; j < points.length; j++) {
        if (groupOf[j] >= 0) continue;
        if (Math.hypot(points[j].x - points[k].x, points[j].y - points[k].y) <= link) {
          groupOf[j] = g;
          stack.push(j);
        }
      }
    }
  }
  return groups;
}

/** A group larger than a page, cut into a grid of page-sized tiles (empty tiles dropped). */
function splitToFit(group: DeskPoint[], capW: number, capH: number): DeskPoint[][] {
  const b = boxOf(group);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (fits(b, capW, capH)) return [group];
  const cols = Math.max(1, Math.ceil(w / capW));
  const rows = Math.max(1, Math.ceil(h / capH));
  const tileW = w / cols || 1;
  const tileH = h / rows || 1;
  const tiles = new Map<string, DeskPoint[]>();
  for (const d of group) {
    const c = Math.min(cols - 1, Math.floor((d.x - b.minX) / tileW));
    const r = Math.min(rows - 1, Math.floor((d.y - b.minY) / tileH));
    const key = `${r}:${c}`;
    const t = tiles.get(key);
    if (t) t.push(d);
    else tiles.set(key, [d]);
  }
  return [...tiles.values()];
}

function boxOf(points: DeskPoint[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function fits(b: Box, capW: number, capH: number): boolean {
  return b.maxX - b.minX <= capW && b.maxY - b.minY <= capH;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
