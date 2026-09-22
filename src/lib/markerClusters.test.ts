import { describe, expect, it } from 'vitest';
import { clusterMarkers, zoomToSplit } from './markerClusters';
import type { ClusterInput } from './markerClusters';

/**
 * The mobile map drew every marker at every zoom, so a bank of desks fitted into a phone-width
 * card came out as a clump of overlapping circles — nothing readable, nothing tappable, no way to
 * tell how many were under there. These pin the replacement.
 */

// A 1492x1054 plan, fitted into a ~340px card: the zoom the phone actually uses.
const plan = { planW: 1492, planH: 1054, minGapPx: 26 };
const fitted = { ...plan, zoom: 0.22 };

function at(id: string, x: number, y: number): ClusterInput {
  return { id, x, y };
}

describe('markers too close to tell apart become one', () => {
  it('leaves well-spaced markers alone, one cluster each', () => {
    const out = clusterMarkers([at('a', 0.1, 0.1), at('b', 0.6, 0.6)], fitted);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.ids.length === 1)).toBe(true);
  });

  it('groups a bank of desks that overlaps at the fitted zoom', () => {
    // Six desks 0.03 apart: 45 plan px, about 10px on screen at z=0.22 — under one 22px chip.
    const desks = Array.from({ length: 6 }, (_, i) => at(`WS-0${i + 1}`, 0.3 + i * 0.03, 0.4));
    const out = clusterMarkers(desks, fitted);

    // Deliberately NOT one bubble for the whole row. A cluster's centre follows its members, so a
    // long row breaks into a bubble per blob — six desks spanning 50px on glass read as two counts
    // in roughly the right places, where one lump would claim a single spot they don't share.
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(desks.length);
    expect(out.flatMap((c) => c.ids)).toHaveLength(6);
  });

  it('splits that same bank apart once it is zoomed in', () => {
    const desks = Array.from({ length: 6 }, (_, i) => at(`WS-0${i + 1}`, 0.3 + i * 0.03, 0.4));
    const out = clusterMarkers(desks, { ...plan, zoom: 1 });
    expect(out).toHaveLength(6);
  });

  it('accounts for every marker exactly once, whatever the zoom', () => {
    const many = Array.from({ length: 40 }, (_, i) => at(`u${i}`, 0.2 + (i % 8) * 0.02, 0.3 + Math.floor(i / 8) * 0.02));
    for (const zoom of [0.15, 0.22, 0.5, 1, 3]) {
      const ids = clusterMarkers(many, { ...plan, zoom }).flatMap((c) => c.ids);
      expect(ids).toHaveLength(40);
      expect(new Set(ids).size).toBe(40);
    }
  });

  it('sits the bubble in the middle of what it stands for', () => {
    const out = clusterMarkers([at('a', 0.3, 0.4), at('b', 0.32, 0.4)], fitted);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBeCloseTo(0.31, 5);
    expect(out[0].y).toBeCloseTo(0.4, 5);
  });

  it('groups the same way whatever order the markers arrive in', () => {
    const many = Array.from({ length: 12 }, (_, i) => at(`u${i}`, 0.25 + (i % 4) * 0.03, 0.5 + Math.floor(i / 4) * 0.03));
    const forwards = clusterMarkers(many, fitted).map((c) => [...c.ids].sort().join(','));
    const backwards = clusterMarkers([...many].reverse(), fitted).map((c) => [...c.ids].sort().join(','));
    expect(backwards.sort()).toEqual(forwards.sort());
  });

  it('never clusters when the caller asks for no gap', () => {
    const desks = Array.from({ length: 6 }, (_, i) => at(`WS-0${i + 1}`, 0.3 + i * 0.001, 0.4));
    expect(clusterMarkers(desks, { ...plan, zoom: 0.22, minGapPx: 0 })).toHaveLength(6);
  });
});

describe('tapping a cluster zooms to where it comes apart', () => {
  it('returns a zoom that actually separates the tightest pair', () => {
    const desks = [at('a', 0.3, 0.4), at('b', 0.33, 0.4), at('c', 0.36, 0.4)];
    const map = new Map(desks.map((d) => [d.id, d]));
    const [cluster] = clusterMarkers(desks, fitted);
    const z = zoomToSplit(cluster, map, fitted);

    expect(z).toBeGreaterThan(fitted.zoom);
    expect(clusterMarkers(desks, { ...plan, zoom: z })).toHaveLength(3);
  });

  it('leaves the zoom alone for a marker that is already on its own', () => {
    const solo = [at('a', 0.3, 0.4)];
    const [cluster] = clusterMarkers(solo, fitted);
    expect(zoomToSplit(cluster, new Map(solo.map((d) => [d.id, d])), fitted)).toBe(fitted.zoom);
  });

  it('survives two markers stacked on the exact same point', () => {
    const stacked = [at('a', 0.3, 0.4), at('b', 0.3, 0.4)];
    const map = new Map(stacked.map((d) => [d.id, d]));
    const [cluster] = clusterMarkers(stacked, fitted);
    // They can never separate, so it asks for more zoom rather than infinity.
    expect(Number.isFinite(zoomToSplit(cluster, map, fitted))).toBe(true);
  });
});
