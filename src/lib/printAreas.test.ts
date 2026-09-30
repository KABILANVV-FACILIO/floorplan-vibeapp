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
  const allLabelled = (area: { zoom: number; deskIds: string[] }) => {
    const placed = planMarkerLabels(inputs, { planW: 1492, planH: 1054, zoom: area.zoom / 1.3 });
    return area.deskIds.every((id) => placed.get(id)?.name && placed.get(id)?.sub && placed.get(id)?.dept);
  };

  it('zooms in on a pod packed tighter than the rest of the floor until each desk fits', () => {
    const plain = planDetailAreas(points, { frameW: FRAME.frameW / 1.3, frameH: FRAME.frameH / 1.3 }).map((a) => ({ ...a, zoom: a.zoom * 1.3 }));
    expect(plain.every(allLabelled)).toBe(false); // the old cut: some pod desk printed bare

    const areas = planLabelledDetailAreas(points, { ...FRAME, labelScale: 1.3, allLabelled });
    expect(areas.every(allLabelled)).toBe(true);
    expect(allIds(areas)).toEqual(points.map((p) => p.id).sort());
  });
});
