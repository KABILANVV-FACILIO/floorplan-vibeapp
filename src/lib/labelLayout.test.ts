import { describe, expect, it } from 'vitest';
import { planMarkerLabels } from './labelLayout';
import type { MarkerLabelInput } from './labelLayout';

/**
 * Labels used to be gated on the zoom alone, which says nothing about whether a label fits: a bank
 * of desks 30px apart on the plan piled its names on top of its neighbours' chips at every zoom
 * where labels showed at all. These pin the replacement — a label is drawn only where there is
 * room for it, and the ones that matter win the space.
 */

const opts = { planW: 1000, planH: 1000, zoom: 1 };

function desk(id: string, x: number, y: number, over: Partial<MarkerLabelInput> = {}): MarkerLabelInput {
  return { id, x, y, size: 24, name: id, rank: 2, ...over };
}

describe('a label is drawn only where it fits', () => {
  it('keeps both labels for markers that are far apart', () => {
    const plan = planMarkerLabels([desk('WS-01', 0.1, 0.1, { sub: 'Amrithya' }), desk('WS-02', 0.6, 0.6, { sub: 'Jonas Weber' })], opts);
    expect(plan.get('WS-01')).toEqual({ name: true, sub: true });
    expect(plan.get('WS-02')).toEqual({ name: true, sub: true });
  });

  it('drops the label that would land on a neighbouring chip', () => {
    // 30 plan px apart vertically: the lower desk's name wants the space the upper desk's chip is in.
    const plan = planMarkerLabels([desk('WS-01', 0.5, 0.5), desk('WS-02', 0.5, 0.53)], opts);
    expect(plan.get('WS-01')?.name).toBe(true);
    expect(plan.get('WS-02')?.name).toBe(false);
  });

  it('drops a holder name that would land on the chip below it', () => {
    const plan = planMarkerLabels([desk('WS-01', 0.5, 0.5, { sub: 'Sofia Rossi' }), desk('WS-02', 0.5, 0.53)], opts);
    expect(plan.get('WS-01')?.sub).toBe(false);
  });

  it('never lets two labels share the same space', () => {
    // Side by side, close enough that the two names would overlap each other.
    const plan = planMarkerLabels([desk('WS-01', 0.5, 0.5), desk('WS-02', 0.53, 0.5)], opts);
    const kept = ['WS-01', 'WS-02'].filter((id) => plan.get(id)?.name);
    expect(kept).toHaveLength(1);
  });

  it('is the zoom, not the marker spacing, that frees the space', () => {
    const pair = [desk('WS-01', 0.5, 0.5), desk('WS-02', 0.5, 0.53)];
    // Same two desks, zoomed in: 30 plan px becomes 120 screen px and both names fit.
    const zoomed = planMarkerLabels(pair, { ...opts, zoom: 4 });
    expect(zoomed.get('WS-01')?.name).toBe(true);
    expect(zoomed.get('WS-02')?.name).toBe(true);
  });
});

describe('when something has to go, the important label stays', () => {
  it('gives contested space to the selected record, whatever order the input arrives in', () => {
    // Side by side: the two names want the same strip, and only one can have it.
    const plan = planMarkerLabels([desk('WS-01', 0.5, 0.5), desk('WS-02', 0.53, 0.5, { rank: 0 })], opts);
    expect(plan.get('WS-02')?.name).toBe(true);
    expect(plan.get('WS-01')?.name).toBe(false);
  });

  it('still refuses to cover a CHIP for it — a hidden marker is worse than a hidden name', () => {
    // The selected desk's name would sit right on the chip above it. Rank buys priority over other
    // labels, never over a marker.
    const plan = planMarkerLabels([desk('WS-01', 0.5, 0.5), desk('WS-02', 0.5, 0.53, { rank: 0 })], opts);
    expect(plan.get('WS-02')?.name).toBe(false);
  });

  it('never drops the "Your desk" pill, even in a pile', () => {
    const crowd = [desk('WS-01', 0.5, 0.5), desk('WS-02', 0.5, 0.52), desk('WS-03', 0.5, 0.54)];
    const mine = desk('WS-04', 0.5, 0.53, { name: 'Your desk', pill: true, must: true, rank: 1 });
    const plan = planMarkerLabels([...crowd, mine], opts);
    expect(plan.get('WS-04')?.name).toBe(true);
  });

  it('places the same labels whatever order the markers arrive in', () => {
    const a = [desk('WS-01', 0.5, 0.5), desk('WS-02', 0.5, 0.53), desk('WS-03', 0.5, 0.56)];
    const forwards = planMarkerLabels(a, opts);
    const backwards = planMarkerLabels([...a].reverse(), opts);
    for (const id of ['WS-01', 'WS-02', 'WS-03']) expect(backwards.get(id)).toEqual(forwards.get(id));
  });
});
