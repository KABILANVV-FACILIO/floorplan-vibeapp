import { describe, expect, it } from 'vitest';
import { deskPitch, planDetailAreas, planLabelledDetailAreas } from './printAreas';
import { planMarkerLabels } from './labelLayout';
import type { MarkerLabelInput } from './labelLayout';
import type { DeskPoint } from './printAreas';

/**
 * The print sheet's detail pages: the floor's desks cut into page-sized areas, each zoomed so every
 * desk carries its labels. These pin that every desk lands on exactly one page, that pods far apart
 * get pages of their own, that nearby pods share, and that a bank too big for a page is split.
 */

const FRAME = { frameW: 988, frameH: 595 };

/** A pod of desks 2 across × `rows` down, `gap` plan px apart, top-left at (x, y). */
function pod(prefix: string, x: number, y: number, rows = 3, gap = 30): DeskPoint[] {
  const out: DeskPoint[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < 2; c++) out.push({ id: `${prefix}${r}${c}`, x: x + c * gap, y: y + r * gap });
  return out;
}

function allIds(areas: { deskIds: string[] }[]): string[] {
  return areas.flatMap((a) => a.deskIds).sort();
}

describe('the plan sets its own scale', () => {
  it('reads the desk pitch as the median nearest-neighbour distance', () => {
    expect(deskPitch(pod('a', 0, 0))).toBe(30);
  });
});

describe('detail pages', () => {
  it('has none for a floor with no desks', () => {
    expect(planDetailAreas([], FRAME)).toEqual([]);
  });

  it('puts every desk on exactly one page', () => {
    const desks = [...pod('a', 100, 100), ...pod('b', 1100, 150), ...pod('c', 150, 800), ...pod('d', 1200, 850)];
    const areas = planDetailAreas(desks, FRAME);
    expect(allIds(areas)).toEqual(desks.map((d) => d.id).sort());
  });

  it('gives pods far apart their own pages, in reading order', () => {
    const areas = planDetailAreas([...pod('b', 1100, 150), ...pod('a', 100, 100), ...pod('c', 150, 900)], FRAME);
    expect(areas).toHaveLength(3);
    expect(areas.map((a) => a.deskIds[0][0])).toEqual(['a', 'b', 'c']);
  });

  it('lets pods close to each other share a page', () => {
    // Two pods with an aisle between them — separate groups, but they fit on one page together.
    const areas = planDetailAreas([...pod('a', 100, 100), ...pod('b', 280, 100)], FRAME);
    expect(areas).toHaveLength(1);
    expect(areas[0].deskIds).toHaveLength(12);
  });

  it('splits a bank of desks too long for one page', () => {
    // One unbroken row of 40 desks, 30px apart: 1170 plan px long — more than a page at the zoom
    // that keeps 30px pitches readable.
    const row: DeskPoint[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${String(i).padStart(2, '0')}`, x: 100 + i * 30, y: 400 }));
    const areas = planDetailAreas(row, FRAME);
    expect(areas.length).toBeGreaterThan(1);
    expect(allIds(areas)).toEqual(row.map((d) => d.id).sort());
  });

  it('zooms so neighbouring desks sit far enough apart on paper for their labels', () => {
    const [area] = planDetailAreas(pod('a', 100, 100), FRAME);
    // 30 plan px apart → at least ~115 screen px apart on the page.
    expect(area.zoom * 30).toBeGreaterThanOrEqual(110);
  });

  it('centres each page on its desks', () => {
    const [area] = planDetailAreas(pod('a', 100, 100), FRAME);
    expect(area.cx).toBe(115);
    expect(area.cy).toBe(130);
  });
});

describe('every desk on a detail page is labelled in full', () => {
  // The floor's usual spacing is 90 plan px (rows of desks); one pod of four sits round a table
  // with desks 14 px apart — like the one that printed its middle desk bare. At the floor's own
  // zoom its chips overlap and nothing fits; zoomed in for it, each desk has its card.
  const rows: DeskPoint[] = Array.from({ length: 24 }, (_, i) => ({ id: `r${i}`, x: 100 + (i % 8) * 90, y: 100 + Math.floor(i / 8) * 90 }));
  const podDesks: DeskPoint[] = [0, 1].flatMap((c) => [
    { id: `p0${c}`, x: 1100 + c * 14, y: 700 },
    { id: `p1${c}`, x: 1100 + c * 14, y: 714 },
  ]);
  const points = [...rows, ...podDesks];
  const inputs: MarkerLabelInput[] = points.map((p) => ({
    id: p.id,
    x: p.x / 1492,
    y: p.y / 1054,
    size: 24,
    name: `New Test Desk ${p.id}`,
    sub: 'Amrithya',
    dept: 'Project Implementation',
    rank: 2,
  }));
  const labelledAt = (zoom: number) => {
    const placed = planMarkerLabels(inputs, { planW: 1492, planH: 1054, zoom: zoom / 1.3 });
    return new Set(inputs.filter((i) => placed.get(i.id)?.name && placed.get(i.id)?.sub && placed.get(i.id)?.dept).map((i) => i.id));
  };
  const allLabelled = (area: { zoom: number; deskIds: string[] }) => area.deskIds.every((id) => labelledAt(area.zoom).has(id));

  it('zooms in on a pod packed tighter than the rest of the floor until each desk fits', () => {
    const areas = planLabelledDetailAreas(points, { ...FRAME, labelScale: 1.3, labelledAt });
    expect(areas.every(allLabelled)).toBe(true);
    expect(allIds(areas)).toEqual(points.map((p) => p.id).sort());
    // The pod is on pages of its own, closer than the rows.
    const rowZoom = Math.min(...areas.filter((a) => a.deskIds.some((id) => id.startsWith('r'))).map((a) => a.zoom));
    const podZoom = Math.max(...areas.filter((a) => a.deskIds.some((id) => id.startsWith('p'))).map((a) => a.zoom));
    expect(podZoom).toBeGreaterThan(rowZoom);
  });

  it('gives a lone pod one page, close up', () => {
    // Seven desks in one corner of a large plan (the org's sixth floor): one detail page, zoomed
    // in on the pod — not the pod as a speck in the corner of an empty page.
    const pod: DeskPoint[] = [0.06, 0.085, 0.11].flatMap((x) => [
      { id: `p${x}a`, x: x * 1492, y: 0.1 * 1054 },
      { id: `p${x}b`, x: x * 1492, y: 0.14 * 1054 },
    ]);
    pod.push({ id: 'p7', x: 0.15 * 1492, y: 0.12 * 1054 });
    const podInputs: MarkerLabelInput[] = pod.map((p) => ({ id: p.id, x: p.x / 1492, y: p.y / 1054, size: 24, name: 'New Test Desk', sub: 'Johar Ali Ali Asghar', dept: 'Investment Executive Program', rank: 2 }));
    const podLabelled = (zoom: number) => {
      const placed = planMarkerLabels(podInputs, { planW: 1492, planH: 1054, zoom: zoom / 1.3 });
      return new Set(podInputs.filter((i) => placed.get(i.id)?.name && placed.get(i.id)?.sub && placed.get(i.id)?.dept).map((i) => i.id));
    };
    const areas = planLabelledDetailAreas(pod, { ...FRAME, labelScale: 1.3, labelledAt: podLabelled });
    expect(areas).toHaveLength(1);
    expect(areas[0].deskIds).toHaveLength(7);
    expect(areas[0].zoom).toBeGreaterThanOrEqual(2);
    expect(areas[0].deskIds.every((id) => podLabelled(areas[0].zoom).has(id))).toBe(true);
  });

  it('cuts the floor at the lowest zoom that completes its cards — not one chosen from desk spacing', () => {
    // A grid at 68 × 46 plan px: the cards fit below each chip from about 2.1x; the pitch rule
    // asked 3.4x and more, and paid for it in pages.
    const grid: DeskPoint[] = [];
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) grid.push({ id: `g${r}_${c}`, x: 90 + c * 68, y: 84 + r * 46 });
    const gridInputs: MarkerLabelInput[] = grid.map((p) => ({ id: p.id, x: p.x / 1492, y: p.y / 1054, size: 24, name: 'E-1-WS' + p.id, sub: 'Layla Al Marzooqi', dept: 'Information Technology', rank: 2 }));
    const gridLabelled = (zoom: number) => {
      const placed = planMarkerLabels(gridInputs, { planW: 1492, planH: 1054, zoom: zoom / 1.3 });
      return new Set(gridInputs.filter((i) => placed.get(i.id)?.name && placed.get(i.id)?.sub && placed.get(i.id)?.dept).map((i) => i.id));
    };
    const areas = planLabelledDetailAreas(grid, { ...FRAME, labelScale: 1.3, labelledAt: gridLabelled });
    expect(allIds(areas)).toEqual(grid.map((p) => p.id).sort());
    for (const a of areas) expect(a.deskIds.every((id) => gridLabelled(a.zoom).has(id))).toBe(true);
    expect(areas.length).toBeLessThanOrEqual(16);
  });
});
