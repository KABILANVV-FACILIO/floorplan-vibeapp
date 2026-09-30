import { describe, expect, it } from 'vitest';
import { fitUnitsView, fitView } from './geometry';
import { IMG_H, IMG_W } from './mockData';

/**
 * What a floor opens on. Fitted to the plan's image, a floor with seven desks in one corner of a
 * large drawing opened as a large drawing with seven specks in the corner; it opens on the desks.
 */
const insets = { left: 336, right: 352, top: 64, bottom: 84 };
const W = 1440;
const H = 900;
const desk = (x: number, y: number, type = 'workstation', unplaced = false) => ({ geom: { kind: 'point' as const, x, y }, type: type as 'workstation', unplaced });
const whole = fitView(W, H, insets);

describe('fitting the view to the desks', () => {
  it('opens on a pod in the corner, zoomed in — but no further than 2x', () => {
    const pod = [desk(0.05, 0.1), desk(0.08, 0.1), desk(0.11, 0.1), desk(0.14, 0.1), desk(0.05, 0.13), desk(0.08, 0.13), desk(0.11, 0.13)];
    const v = fitUnitsView(pod, W, H, insets);
    expect(v.z).toBeGreaterThan(whole.z);
    expect(v.z).toBeLessThanOrEqual(2);
    // The pod's centre lands in the centre of the stage left free by the panels.
    const cx = 0.095 * IMG_W;
    const cy = 0.115 * IMG_H;
    expect(v.tx + cx * v.z).toBeCloseTo(insets.left + (W - insets.left - insets.right) / 2, 0);
    expect(v.ty + cy * v.z).toBeCloseTo(insets.top + (H - insets.top - insets.bottom) / 2, 0);
  });

  it('never zooms out past the whole floor when the desks span it', () => {
    const v = fitUnitsView([desk(0.02, 0.02), desk(0.98, 0.98)], W, H, insets);
    expect(v.z).toBeCloseTo(whole.z, 5);
  });

  it('ignores amenities and unplaced records — a lift at the far end would pull the box out to nothing', () => {
    const pod = [desk(0.05, 0.1), desk(0.08, 0.13)];
    const withLift = [...pod, desk(0.95, 0.95, 'amenity'), desk(0.9, 0.2, 'workstation', true)];
    expect(fitUnitsView(withLift, W, H, insets)).toEqual(fitUnitsView(pod, W, H, insets));
  });

  it('fits the whole plan when nothing is placed', () => {
    expect(fitUnitsView([], W, H, insets)).toEqual(whole);
  });
});
