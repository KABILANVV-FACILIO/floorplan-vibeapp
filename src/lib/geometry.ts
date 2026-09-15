import { IMG_H, IMG_W } from './mockData';
import type { PointGeom, PolyGeom, Unit, UnitGeom } from './types';

export interface ViewTransform {
  tx: number;
  ty: number;
  z: number;
}

/** Overlay chrome (floating panels, mode switcher, bottom nav) eating into the stage. */
export interface ViewInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function fitView(rectW: number, rectH: number, insets?: Partial<ViewInsets>): ViewTransform {
  const l = insets?.left ?? 0;
  const r = insets?.right ?? 0;
  const t = insets?.top ?? 0;
  const b = insets?.bottom ?? 0;
  const availW = Math.max(120, rectW - l - r);
  const availH = Math.max(120, rectH - t - b);
  const z = Math.min(availW / IMG_W, availH / IMG_H) * 0.96;
  return { z, tx: l + (availW - IMG_W * z) / 2, ty: t + (availH - IMG_H * z) / 2 };
}

export function zoomAt(view: ViewTransform, factor: number, cx: number, cy: number): ViewTransform {
  const z = clamp(view.z * factor, 0.08, 6);
  const k = z / view.z;
  return { z, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Screen client coords -> normalized (0-1) plan coords, given the canvas rect and view transform. */
export function toNorm(clientX: number, clientY: number, rect: DOMRect, view: ViewTransform) {
  return {
    x: (clientX - rect.left - view.tx) / view.z / IMG_W,
    y: (clientY - rect.top - view.ty) / view.z / IMG_H,
  };
}

export function unitCenter(u: Pick<Unit, 'geom'>): { cx: number; cy: number; span: number } {
  if (u.geom.kind === 'point') {
    return { cx: u.geom.x, cy: u.geom.y, span: 0.06 };
  }
  const pts = u.geom.pts;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, span: Math.max(maxX - minX, maxY - minY, 0.08) };
}

/** View transform that centers+zooms on a unit, per the original focusUnit() formula. */
export function focusUnitView(
  u: Pick<Unit, 'geom'>,
  rectW: number,
  rectH: number,
  currentZ: number,
  insets?: Partial<ViewInsets>,
): ViewTransform {
  const { cx, cy, span } = unitCenter(u);
  const l = insets?.left ?? 0;
  const r = insets?.right ?? 0;
  const t = insets?.top ?? 0;
  const b = insets?.bottom ?? 0;
  const centerX = l + (rectW - l - r) / 2;
  const centerY = t + (rectH - t - b) / 2;
  let z: number;
  if (u.geom.kind === 'point') {
    z = clamp(Math.max(currentZ, 1.25), 1.25, 2.4);
  } else {
    z = clamp(Math.min(2.4, (Math.min(rectW, rectH) * 0.7) / (span * IMG_W)), 0.6, 2.4);
  }
  return { z, tx: centerX - cx * IMG_W * z, ty: centerY - cy * IMG_H * z };
}

export function clipPathFor(geom: PolyGeom): string {
  return `polygon(${geom.pts.map(([x, y]) => `${(x * 100).toFixed(3)}% ${(y * 100).toFixed(3)}%`).join(', ')})`;
}

export function polygonCentroid(pts: [number, number][]): { x: number; y: number } {
  const n = pts.length;
  const x = pts.reduce((s, p) => s + p[0], 0) / n;
  const y = pts.reduce((s, p) => s + p[1], 0) / n;
  return { x, y };
}

/** Shoelace formula in pixel space, divided by px-per-meter squared. Null if uncalibrated. */
export function polyAreaM2(pts: [number, number][], pxPerMeter: number | null): number | null {
  if (!pxPerMeter) return null;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[(i + 1) % pts.length];
    a += (xj * IMG_W + xi * IMG_W) * (yj * IMG_H - yi * IMG_H);
  }
  return Math.abs(a / 2) / (pxPerMeter * pxPerMeter);
}

export function distNormToPx(a: [number, number], b: [number, number], z: number): number {
  return Math.hypot((b[0] - a[0]) * IMG_W, (b[1] - a[1]) * IMG_H) * z;
}

export function calibratedPxPerMeter(a: [number, number], b: [number, number], meters: number): number {
  const distPx = Math.hypot((b[0] - a[0]) * IMG_W, (b[1] - a[1]) * IMG_H);
  return distPx / meters;
}

export function pointInPoly(pt: { x: number; y: number }, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointGeom(g: UnitGeom): g is PointGeom {
  return g.kind === 'point';
}
export function isPolyGeom(g: UnitGeom): g is PolyGeom {
  return g.kind === 'poly';
}

/** Natural sort (numeric-aware) — "WS-2" sorts before "WS-10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

const TYPE_RANK: Record<Unit['type'], number> = { workstation: 0, room: 1, delivery: 2, locker: 3, parking: 4, amenity: 5 };
export function unitSortCompare(a: Unit, b: Unit): number {
  const r = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (r !== 0) return r;
  return naturalCompare(a.label, b.label);
}

export function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface TooltipPlacement {
  /** Card CENTRE on x, card TOP on y — both already inside the stage. */
  sx: number;
  sy: number;
  below: boolean;
  transform: string;
  /** Where the caret sits along the card's own width, as a CSS percentage — it must keep pointing at the marker even after the card is nudged off the edge. */
  caretLeft: string;
}

/** Gap between the marker and the card, and the minimum breathing room against a stage edge. */
const TOOLTIP_GAP = 20;
const TOOLTIP_MARGIN = 6;

/**
 * Where the selected unit's card goes, in stage coordinates.
 *
 * The stage clips (`.wrap` is `overflow: hidden`), so a card centred on a marker near an edge was
 * simply cut in half — the closer the marker to a corner, the less of its card survived, which
 * reads as the tooltip being broken rather than positioned. So the card is kept inside the stage
 * on both axes and the caret slides along it to keep pointing at the actual marker.
 *
 * `size` is the card's MEASURED box (the caller measures the rendered node): its height swings
 * from ~110px for an amenity to ~230px in assign mode with two action buttons, and the previous
 * fixed 180px flip threshold guessed wrong for the tall variants — they opened upward with their
 * heads off the top of the stage.
 */
export function tooltipPlacement(
  cx: number,
  cy: number,
  view: ViewTransform,
  stage?: { w: number; h: number },
  size?: { w: number; h: number }
): TooltipPlacement {
  const sx = view.tx + cx * IMG_W * view.z;
  const sy = view.ty + cy * IMG_H * view.z;

  const stageW = stage?.w ?? 0;
  const stageH = stage?.h ?? 0;
  const cardW = size?.w ?? 214;
  const cardH = size?.h ?? 150;

  // Prefer above (the established look); flip below only when the card wouldn't clear the top —
  // and stay above anyway if below has even less room, so the overflow goes to the roomier side.
  const roomAbove = sy - TOOLTIP_GAP - cardH;
  const roomBelow = stageH ? stageH - (sy + TOOLTIP_GAP + cardH) : Number.POSITIVE_INFINITY;
  const below = roomAbove < TOOLTIP_MARGIN && roomBelow > roomAbove;

  // The card's own top edge, CLAMPED into the stage — the y offset is no longer left to a CSS
  // transform. Positioning by the marker and shifting -100% in CSS meant a marker near the top
  // put the whole card above the stage, where `overflow: hidden` simply erased it: the tooltip
  // "didn't open" when in fact it had, out of sight. Same for a marker below the fold.
  let top = below ? sy + TOOLTIP_GAP : sy - TOOLTIP_GAP - cardH;
  if (stageH > 0) {
    const minTop = TOOLTIP_MARGIN;
    const maxTop = stageH - cardH - TOOLTIP_MARGIN;
    top = maxTop < minTop ? minTop : clamp(top, minTop, maxTop);
  }

  // Horizontal: centred on the marker, then pushed back inside the stage. A stage narrower than
  // the card can't satisfy both edges — pin to the left one rather than producing a max < min.
  const half = cardW / 2;
  let left = sx;
  if (stageW > 0) {
    const min = half + TOOLTIP_MARGIN;
    const max = stageW - half - TOOLTIP_MARGIN;
    left = max < min ? min : clamp(sx, min, max);
  }

  // The caret tracks the marker across the card, stopping short of the rounded corners.
  const caretPct = cardW > 0 ? clamp(((sx - left) / cardW + 0.5) * 100, 8, 92) : 50;

  return {
    sx: left,
    sy: top,
    below,
    // x only: the y is already resolved and clamped above.
    transform: 'translate(-50%, 0)',
    caretLeft: `${caretPct.toFixed(2)}%`,
  };
}

export interface PanelBox {
  x: number;
  y: number;
}

export function defaultPanelPos(id: 'location' | 'details', stageW: number): PanelBox {
  if (id === 'location') return { x: 16, y: 16 };
  return { x: Math.max(16, stageW - 320), y: 16 };
}

export function clampPanelPos(x: number, y: number, w: number, stageW: number, stageH: number): PanelBox {
  return {
    x: clamp(x, 4, Math.max(4, stageW - w - 4)),
    y: clamp(y, 4, Math.max(4, stageH - 60)),
  };
}

/**
 * How tall a floating panel may be, given where its top sits.
 *
 * Preferred height keeps the panel clear of the stage's bottom-left overlays (the legend and the
 * "Reset layout" button, ~92px plus shadow bleed). But that preference must never win over the
 * stage's actual edge: the stage clips (`overflow: hidden`), so a panel sized past the bottom
 * loses its own scrollbar along with the content under it — the panel looks like it fits, shows
 * no way to scroll, and the rest is simply gone. Dragging a panel low enough used to do exactly
 * that, because the 180px floor applied even when less than 180px was left.
 */
const PANEL_BOTTOM_CLEARANCE = 120;
const PANEL_EDGE_MARGIN = 12;
const PANEL_MIN_HEIGHT = 180;

export function panelMaxHeight(stageH: number, panelY: number): number {
  const hardRoom = Math.max(80, stageH - panelY - PANEL_EDGE_MARGIN);
  const preferred = stageH - panelY - PANEL_BOTTOM_CLEARANCE;
  return Math.min(hardRoom, Math.max(PANEL_MIN_HEIGHT, preferred));
}
