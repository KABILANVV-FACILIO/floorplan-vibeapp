import { describe, expect, it } from 'vitest';
import { deskPitch, planDetailAreas } from './printAreas';
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
