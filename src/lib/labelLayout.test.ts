import { describe, expect, it } from 'vitest';
import { CARD_PAD_X, CHIP_FOOTPRINT_OF_PITCH, CHIP_MAX_SCALE, CHIP_MIN_PX, CHIP_PX, DEFAULT_LABEL_TYPOGRAPHY, cardOffset, chipScreenSize, chipSizeNear, planMarkerLabels, planRoomLabels, scaleTypography, typographyOf } from './labelLayout';
import type { LabelPlacement, MarkerLabelInput, RoomLabelInput } from './labelLayout';
import { chipPitch, deskPitch, nearestDistances } from './printAreas';

/**
 * Labels used to be gated on the zoom alone, which says nothing about whether a label fits: a bank
 * of desks 30px apart on the plan piled its names on top of its neighbours' chips at every zoom
 * where labels showed at all. These pin the replacement — each desk's card is drawn only where
 * there is room for it, around its chip, and the ones that matter win the space.
 */

const opts = { planW: 1000, planH: 1000, zoom: 1 };

function desk(id: string, x: number, y: number, over: Partial<MarkerLabelInput> = {}): MarkerLabelInput {
  return { id, x, y, size: 24, name: id, rank: 2, ...over };
}

/** The card's box on screen, from its placement — what the markup draws. */
function cardBox(i: MarkerLabelInput, p: LabelPlacement | undefined) {
  if (!p?.name || !p.pos || !p.w || !p.h) return null;
  const { dx, dy } = cardOffset(p.pos, p.w, p.h, i.size / 2);
  return { x: i.x * opts.planW * opts.zoom + dx, y: i.y * opts.planH * opts.zoom + dy, w: p.w, h: p.h };
}
const chipBox = (i: MarkerLabelInput) => ({ x: i.x * opts.planW - i.size / 2, y: i.y * opts.planH - i.size / 2, w: i.size, h: i.size });
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** No card on any chip, and no two cards on each other. */
function expectClean(inputs: MarkerLabelInput[], plan: Map<string, LabelPlacement>) {
  const cards = inputs.map((i) => ({ i, box: cardBox(i, plan.get(i.id)) })).filter((c) => c.box);
  for (const c of cards) for (const i of inputs) expect(overlap(c.box!, chipBox(i))).toBe(false);
  for (const a of cards) for (const b of cards) if (a !== b) expect(overlap(a.box!, b.box!)).toBe(false);
}

describe('a card is drawn only where it fits', () => {
  it('gives markers that are far apart their whole card, under the chip', () => {
    const plan = planMarkerLabels([desk('WS-01', 0.1, 0.1, { sub: 'Amrithya', dept: 'Finance' }), desk('WS-02', 0.6, 0.6, { sub: 'Jonas Weber' })], opts);
    expect(plan.get('WS-01')).toMatchObject({ name: true, sub: true, dept: true, pos: 'below' });
    expect(plan.get('WS-02')).toMatchObject({ name: true, sub: true, pos: 'below' });
  });

  it('gives a free desk its name alone, above its chip', () => {
    expect(planMarkerLabels([desk('WS-01', 0.5, 0.5)], opts).get('WS-01')).toMatchObject({ name: true, sub: false, pos: 'above' });
  });

  it('never lands a card on a chip, nor two cards on each other', () => {
    const inputs = [
      desk('WS-01', 0.5, 0.5, { sub: 'David Chen', dept: 'Facilities' }),
      desk('WS-02', 0.5, 0.53, { sub: 'Amrithya', dept: 'Finance' }),
      desk('WS-03', 0.52, 0.515, { sub: 'Sofia Rossi', dept: 'Operations' }),
      desk('WS-04', 0.53, 0.5),
      desk('WS-05', 0.47, 0.5, { sub: 'Lena Hoffmann' }),
    ];
    expectClean(inputs, planMarkerLabels(inputs, opts));
  });

  it('moves the card to the side when the space above and below is taken', () => {
    // Chips 30px above and below: a card fits neither there nor on the corners, but does beside.
    const inputs = [desk('WS-01', 0.5, 0.5, { sub: 'Amrithya' }), desk('WS-00', 0.5, 0.47), desk('WS-02', 0.5, 0.53)];
    const plan = planMarkerLabels(inputs, opts);
    expect(plan.get('WS-01')?.name).toBe(true);
    expect(['right', 'left']).toContain(plan.get('WS-01')?.pos);
    expectClean(inputs, plan);
  });

  it('keeps the name and drops the rest when only a small card fits', () => {
    // Boxed in on all eight sides at 48px: room for a name under the chip, not for a card.
    const inputs = [desk('WS-01', 0.5, 0.5, { sub: 'Abdulrahman AlAnazi', dept: 'Investment Executive Program' })];
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (dx || dy) inputs.push(desk(`N${dx}${dy}`, 0.5 + dx * 0.048, 0.5 + dy * 0.048));
    const plan = planMarkerLabels(inputs, opts);
    const p = plan.get('WS-01')!;
    expect(p.name).toBe(true);
    expect(p.sub || p.dept).toBeFalsy();
    expectClean(inputs, plan);
  });

  it('never carries a holder without the name (a caption under one desk read as another desk’s)', () => {
    const inputs = [desk('WS-01', 0.5, 0.5, { sub: 'David Chen' }), desk('WS-02', 0.5, 0.53, { sub: 'Amrithya' }), desk('WS-03', 0.52, 0.515, { sub: 'Sofia Rossi' })];
    for (const p of planMarkerLabels(inputs, opts).values()) if (p.sub) expect(p.name).toBe(true);
  });

  it('is the zoom, not the marker spacing, that frees the space', () => {
    // A desk boxed in on all eight sides at 30px has no room at all; zoomed to 4x it has a card.
    const block = [desk('WS-01', 0.5, 0.5, { sub: 'Amrithya', dept: 'Finance' })];
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (dx || dy) block.push(desk(`N${dx}${dy}`, 0.5 + dx * 0.03, 0.5 + dy * 0.03));
    expect(planMarkerLabels(block, opts).get('WS-01')?.name).toBe(false);
    expect(planMarkerLabels(block, { ...opts, zoom: 4 }).get('WS-01')).toMatchObject({ name: true, sub: true, dept: true });
  });
});

describe('the card fits its text', () => {
  it('runs as wide as a long name needs, up to 180px', () => {
    const plan = planMarkerLabels([desk('E-1-WS77', 0.5, 0.5, { sub: 'Abdulrahman Abdullah Khalaf AlAnazi', dept: 'Finance' })], opts);
    const p = plan.get('E-1-WS77')!;
    expect(p.w).toBeGreaterThan(120);
    expect(p.w).toBeLessThanOrEqual(180);
  });

  it('runs a long department to a second line rather than cutting it', () => {
    const plan = planMarkerLabels([desk('E-1-WS77', 0.5, 0.5, { sub: 'Johar Ali Ali Asghar', dept: 'Chief Communications & Public Relations Officer Office' })], opts);
    expect(plan.get('E-1-WS77')).toMatchObject({ dept: true, deptLines: 2, w: 180 });
  });

  it('reserves the measured width when the canvas measured the text', () => {
    const estimated = planMarkerLabels([desk('WS-01', 0.5, 0.5, { sub: 'Amrithya' })], opts).get('WS-01')!;
    const measured = planMarkerLabels([desk('WS-01', 0.5, 0.5, { sub: 'Amrithya', nameW: 60, subW: 90 })], opts).get('WS-01')!;
    expect(measured.w).toBe(90 + 2 * CARD_PAD_X);
    expect(measured.w).not.toBe(estimated.w);
  });
});

describe('a card keeps its spot while zooming', () => {
  it('stays where it was while that still fits, instead of hopping to its first-choice side', () => {
    // A desk 30px below pushes A's card above at zoom 1. Zoomed to 4x the space below is free —
    // placed afresh the card would move below; given the last plan it stays above.
    const pair = [desk('A', 0.5, 0.5, { sub: 'Amrithya', dept: 'Finance' }), desk('B', 0.5, 0.53, { sub: 'Jonas Weber' })];
    const before = planMarkerLabels(pair, opts);
    expect(before.get('A')?.pos).toBe('above');
    expect(planMarkerLabels(pair, { ...opts, zoom: 4 }).get('A')?.pos).toBe('below');
    expect(planMarkerLabels(pair, { ...opts, zoom: 4, previous: before }).get('A')?.pos).toBe('above');
  });

  it('grows in place when the zoom makes room', () => {
    // Boxed in at 30px, A has nothing; at 48px a name fits below; at 4x the whole card fits — below.
    const block = (gap: number) => {
      const b = [desk('A', 0.5, 0.5, { sub: 'Amrithya', dept: 'Finance' })];
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (dx || dy) b.push(desk(`N${dx}${dy}`, 0.5 + dx * gap, 0.5 + dy * gap));
      return b;
    };
    const small = planMarkerLabels(block(0.048), opts);
    expect(small.get('A')).toMatchObject({ name: true, sub: false });
    const grown = planMarkerLabels(block(0.048), { ...opts, zoom: 4, previous: small });
    expect(grown.get('A')).toMatchObject({ name: true, sub: true, dept: true, pos: small.get('A')!.pos });
  });

  it('moves only when its spot no longer fits', () => {
    const before = planMarkerLabels([desk('A', 0.5, 0.5, { sub: 'Amrithya' })], opts);
    expect(before.get('A')?.pos).toBe('below');
    // A desk appears right under A: the card below no longer fits and goes elsewhere.
    const after = planMarkerLabels([desk('A', 0.5, 0.5, { sub: 'Amrithya' }), desk('B', 0.5, 0.53)], { ...opts, previous: before });
    expect(after.get('A')?.name).toBe(true);
    expect(after.get('A')?.pos).not.toBe('below');
  });
});

describe('a bank of desks carries its cards in one line', () => {
  it('takes the side its nearest placed neighbour took, when that fits', () => {
    // A has a chip right under it, so its card goes above. B, 60px to the right, could go below —
    // beside A it goes above too, so the two read as one row of cards.
    const inputs = [desk('A', 0.5, 0.5, { sub: 'Amrithya', dept: 'Finance' }), desk('blocker', 0.5, 0.53), desk('B', 0.56, 0.5, { sub: 'Jonas Weber' })];
    const plan = planMarkerLabels(inputs, opts);
    expect(plan.get('A')?.pos).toBe('above');
    expect(plan.get('B')?.pos).toBe('above');
    // On its own B would have gone below.
    expect(planMarkerLabels([desk('B', 0.56, 0.5, { sub: 'Jonas Weber' })], opts).get('B')?.pos).toBe('below');
  });
});

describe('when something has to go, the important label stays', () => {
  it('gives the selected record first choice, whatever order the input arrives in', () => {
    // Side by side, 60px apart, both wanting a full card below: only one can have it there.
    const long = { sub: 'Amrithya Ramaswamy', dept: 'Project Implementation' };
    const plan = planMarkerLabels([desk('WS-01', 0.5, 0.5, long), desk('WS-02', 0.56, 0.5, { ...long, rank: 0 })], opts);
    expect(plan.get('WS-02')?.pos).toBe('below');
    expect(plan.get('WS-01')?.pos).not.toBe('below');
  });

  it('still refuses to cover a CHIP for it — a hidden marker is worse than a hidden name', () => {
    const inputs = [desk('WS-01', 0.5, 0.5), desk('WS-02', 0.5, 0.53, { rank: 0 })];
    const plan = planMarkerLabels(inputs, opts);
    expectClean(inputs, plan);
  });

  it('never drops the "Your desk" pill, even in a pile; its card is optional', () => {
    const crowd = [desk('WS-01', 0.5, 0.5), desk('WS-02', 0.5, 0.52), desk('WS-03', 0.5, 0.54)];
    const mine = desk('WS-04', 0.5, 0.53, { pill: true, must: true, rank: 1, sub: 'Amrithya' });
    const plan = planMarkerLabels([...crowd, mine], opts);
    expect(plan.get('WS-04')?.pill).toBe(true);
  });

  it('keeps the card off the space the pill takes', () => {
    const plan = planMarkerLabels([desk('WS-01', 0.5, 0.5, { pill: true, must: true, rank: 1, sub: 'Amrithya' })], opts);
    expect(plan.get('WS-01')?.pill).toBe(true);
    expect(plan.get('WS-01')?.pos).not.toBe('above');
  });

  it('places the same labels whatever order the markers arrive in', () => {
    const a = [desk('WS-01', 0.5, 0.5, { sub: 'A' }), desk('WS-02', 0.5, 0.53, { sub: 'B' }), desk('WS-03', 0.5, 0.56, { sub: 'C' })];
    const forwards = planMarkerLabels(a, opts);
    const backwards = planMarkerLabels([...a].reverse(), opts);
    for (const id of ['WS-01', 'WS-02', 'WS-03']) expect(backwards.get(id)).toEqual(forwards.get(id));
  });
});

describe('room names are drawn only where they fit', () => {
  /** A w x h room (normalized) whose top-left corner is at x, y, labelled at its centre. */
  function room(id: string, x: number, y: number, w: number, h: number, over: Partial<RoomLabelInput> = {}): RoomLabelInput {
    return { id, pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], x: x + w / 2, y: y + h / 2, name: id, ...over };
  }
  // The onboarded floors' plan size, at a typical fit-to-screen zoom with the side panels open.
  const fit = { planW: 1492, planH: 1054, zoom: 0.4 };

  it('names a small room just outside its outline — below it — instead of dropping the name', () => {
    // A toilet ~3% of the plan wide: ~18px on screen, for a name ~150px wide.
    const shown = planRoomLabels([room('HQ-BKB-1F-Male Toilet', 0.4, 0.4, 0.03, 0.05)], fit);
    const p = shown.get('HQ-BKB-1F-Male Toilet')!;
    expect(p.outside).toBe(true);
    expect(p.lines).toBe(1);
    expect(p.dy).toBeGreaterThan(0);
  });

  it('names two small neighbouring rooms on opposite sides rather than on each other — as on Block B 1F', () => {
    const shown = planRoomLabels([room('HQ-BKB-1F-Male Toilet', 0.4, 0.4, 0.03, 0.05), room('HQ-BKB-1F-Female Toilet', 0.43, 0.4, 0.03, 0.05)], fit);
    expect(shown.size).toBe(2);
    const [a, b] = [...shown.values()];
    expect(Math.sign(a.dy)).not.toBe(Math.sign(b.dy));
    const apart = a.box.x + a.box.w <= b.box.x || b.box.x + b.box.w <= a.box.x || a.box.y + a.box.h <= b.box.y || b.box.y + b.box.h <= a.box.y;
    expect(apart).toBe(true);
  });

  it("moves a room's name inside once zoomed in far enough for it to fit there", () => {
    const toilet = room('Toilet', 0.4, 0.4, 0.03, 0.05);
    expect(planRoomLabels([toilet], fit).get('Toilet')?.outside).toBe(true);
    expect(planRoomLabels([toilet], { ...fit, zoom: 2 }).get('Toilet')).toMatchObject({ outside: false, dx: 0, dy: 0 });
  });

  it('runs a long name to two lines in a room wide enough for that, rather than putting it outside', () => {
    const p = planRoomLabels([room('Innovation Collaboration Hub', 0.3, 0.3, 0.12, 0.06)], { ...fit, zoom: 1 }).get('Innovation Collaboration Hub')!;
    expect(p).toMatchObject({ outside: false, lines: 2 });
    expect(p.w).toBeLessThanOrEqual(0.12 * fit.planW);
  });

  it('keeps the bigger room inside and moves the smaller one out when their names would collide', () => {
    // A room outlined inside another, with the same centre: the names would land on each other.
    const shown = planRoomLabels([room('Open Office', 0.1, 0.1, 0.5, 0.5), room('Pod', 0.29, 0.32, 0.12, 0.06)], { ...fit, zoom: 1 });
    expect(shown.get('Open Office')?.outside).toBe(false);
    expect(shown.get('Pod')?.outside).toBe(true);
  });

  it('always shows the selected room at its centroid, and everything else yields to it', () => {
    const shown = planRoomLabels([room('Open Office', 0.1, 0.1, 0.5, 0.5), room('Pod', 0.29, 0.32, 0.12, 0.06, { must: true })], { ...fit, zoom: 1 });
    expect(shown.get('Pod')).toMatchObject({ outside: false, dx: 0, dy: 0 });
    expect(shown.get('Open Office')?.outside).toBe(true);
    expect(planRoomLabels([room('HQ-BKB-1F-Male Toilet', 0.4, 0.4, 0.03, 0.05, { must: true })], fit).size).toBe(1);
  });

  it('keeps every name on a roomy floor, inside its room', () => {
    const shown = planRoomLabels([room('Board Room', 0.1, 0.1, 0.3, 0.3), room('Pantry', 0.6, 0.6, 0.3, 0.3)], { ...fit, zoom: 1 });
    expect([...shown.keys()].sort()).toEqual(['Board Room', 'Pantry']);
    expect([...shown.values()].every((p) => !p.outside)).toBe(true);
  });

  it("never puts a room's name under a desk chip — the desks along a small office's wall are taken first", () => {
    // A small office with a desk right under its wall, where "below" would land the name.
    const office = room('HQ-BKC-4F- Majed Almaskri Office', 0.4, 0.4, 0.04, 0.05);
    const z = 1;
    const chip = { x: 0.42 * fit.planW * z - 12, y: (0.45 * fit.planH + 10) * z - 12, w: 24, h: 24 };
    const p = planRoomLabels([office], { ...fit, zoom: z, reserved: [chip] }).get(office.id)!;
    expect(p.outside).toBe(true);
    expect(p.dy).toBeLessThan(0); // above, not on the desk
    const apart = p.box.x + p.box.w <= chip.x || chip.x + chip.w <= p.box.x || p.box.y + p.box.h <= chip.y || chip.y + chip.h <= p.box.y;
    expect(apart).toBe(true);
  });

  it('keeps the desk cards off the room names', () => {
    const rooms = planRoomLabels([room('Pod', 0.29, 0.32, 0.12, 0.06)], { ...fit, zoom: 1 });
    const reserved = [...rooms.values()].map((p) => p.box);
    // A desk right under the room's name: its card has to go somewhere else.
    const desk: MarkerLabelInput = { id: 'd', x: 0.35, y: 0.37, size: 24, name: 'WS-01', sub: 'Ann', rank: 2 };
    const p = planMarkerLabels([desk], { ...fit, zoom: 1, reserved }).get('d')!;
    expect(p.name).toBe(true);
    expect(p.pos).not.toBe('above');
  });
});

describe('the type the labels are drawn in', () => {
  it('reserves a taller and wider card for a larger type, and the default reproduces today\'s card', () => {
    const input: MarkerLabelInput = { id: 'a', x: 0.5, y: 0.5, size: 24, name: 'WS-01', sub: 'Ann Example', dept: 'Finance', rank: 2 };
    const small = planMarkerLabels([input], { planW: 1000, planH: 1000, zoom: 1 }).get('a')!;
    const large = planMarkerLabels([input], { planW: 1000, planH: 1000, zoom: 1, typography: typographyOf({ name: { size: 12, weight: 700 }, detail: { size: 11, weight: 500 } }) }).get('a')!;
    expect(small.h).toBe(2 * 2 + 10 + 10 + 9); // padding + the three default line heights
    expect(large.h).toBeGreaterThan(small.h!);
    expect(large.w).toBeGreaterThan(small.w!);
  });
});

describe('chipScreenSize', () => {
  it('holds the readable size on a whole-floor view, tracks the drawing zooming in, and stops at the cap', () => {
    const footprint = 20; // plan px — a share of this floor's desk pitch (44 plan px)
    expect(chipScreenSize(0.7, footprint)).toBe(CHIP_PX); // 14px would be a speck; 31px apart, 24 fits
    expect(chipScreenSize(1.2, footprint)).toBe(CHIP_PX); // exactly the floor
    expect(chipScreenSize(2, footprint)).toBe(40);
    expect(chipScreenSize(3, footprint)).toBe(60);
    expect(chipScreenSize(6, footprint)).toBe(CHIP_PX * CHIP_MAX_SCALE);
  });

  it('never shrinks as the zoom grows', () => {
    let last = 0;
    for (let z = 0.1; z <= 8; z += 0.1) {
      const s = chipScreenSize(z, 30);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it('gives way where the spaces sit closer than a chip, so neighbours never cover each other', () => {
    // A car park on a whole-floor view: stalls 16px apart on screen.
    const footprint = 40 * CHIP_FOOTPRINT_OF_PITCH;
    const size = chipScreenSize(0.4, footprint);
    expect(size).toBeLessThan(16);
    expect(size).toBeGreaterThan(12);
    // And never below a mark you can still see and click.
    expect(chipScreenSize(0.05, footprint)).toBe(CHIP_MIN_PX);
  });

  it('is the constant size when the floor has no pitch to speak of', () => {
    expect(chipScreenSize(3, null)).toBe(CHIP_PX);
    expect(chipScreenSize(3, 0)).toBe(CHIP_PX);
  });

  it('is what the layout places against — each placement carries the half it used', () => {
    const inputs: MarkerLabelInput[] = [{ id: 'a', x: 0.5, y: 0.5, size: 48, name: 'WS-01', sub: 'Ann', rank: 2 }];
    const plan = planMarkerLabels(inputs, { planW: 1000, planH: 1000, zoom: 2 });
    expect(plan.get('a')?.half).toBe(24);
    expect(plan.get('a')?.name).toBe(true);
  });
});

describe('the labels grow with the drawing', () => {
  it('scales every font and its line height, and leaves the type alone at 1', () => {
    const t = DEFAULT_LABEL_TYPOGRAPHY;
    expect(scaleTypography(t, 1)).toBe(t);
    const big = scaleTypography(t, 2);
    expect(big.nameFont).toBe(17);
    expect(big.subFont).toBe(16);
    expect(big.deptFont).toBe(15);
    expect(big.nameLine).toBe(Math.round(17 * 1.2));
    expect(big.nameWeight).toBe(t.nameWeight);
  });

  it('reserves a wider card for a larger type rather than cutting the same text shorter', () => {
    const input: MarkerLabelInput = { id: 'a', x: 0.5, y: 0.5, size: 24, name: 'WS-01', sub: 'Someone With A Long Name', dept: 'Project Implementation', rank: 2 };
    const base = planMarkerLabels([input], { planW: 1000, planH: 1000, zoom: 1 }).get('a')!;
    const big = planMarkerLabels([input], { planW: 1000, planH: 1000, zoom: 1, typography: scaleTypography(DEFAULT_LABEL_TYPOGRAPHY, 2) }).get('a')!;
    expect(big.w).toBeGreaterThan(base.w!);
    expect(big.dept).toBe(true);
  });

  it('reserves a room name at its scaled size and says which size it reserved', () => {
    const r: RoomLabelInput = { id: 'r', pts: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.4], [0.1, 0.4]], x: 0.3, y: 0.25, name: 'Board Room' };
    const base = planRoomLabels([r], { planW: 1000, planH: 1000, zoom: 1 }).get('r')!;
    const big = planRoomLabels([r], { planW: 1000, planH: 1000, zoom: 1, labelScale: 2 }).get('r')!;
    expect(big.fontPx).toBe(22);
    expect(big.h).toBeGreaterThan(base.h);
    expect(big.w).toBeGreaterThan(base.w);
  });
});

describe('chipSizeNear: a few desks set close on a sparse floor', () => {
  // A small test floor: spaces some 300 plan px apart, and three desks set 40 px apart (ENEC, 2026-11-17).
  const pts = [
    { id: 'a', x: 100, y: 100 }, { id: 'b', x: 400, y: 120 }, { id: 'c', x: 700, y: 90 }, { id: 'd', x: 120, y: 420 },
    { id: 'e', x: 720, y: 430 }, { id: 'f', x: 420, y: 700 }, { id: 'g', x: 800, y: 720 },
    { id: 'k1', x: 400, y: 400 }, { id: 'k2', x: 400, y: 440 }, { id: 'k3', x: 400, y: 480 },
  ];
  const zoom = 0.86;
  const nearest = nearestDistances(pts);
  const size = chipScreenSize(zoom, deskPitch(pts) * CHIP_FOOTPRINT_OF_PITCH);

  it('draws the floor\'s chip bigger than the gap between the close three — the overlap that was reported', () => {
    expect(size).toBeGreaterThan(40 * zoom);
  });

  it('shrinks just those three to under their gap, and leaves every other chip the floor\'s size', () => {
    for (const id of ['k1', 'k2', 'k3']) {
      const own = chipSizeNear(size, zoom, nearest.get(id));
      expect(own).toBeLessThan(40 * zoom);
      expect(own).toBeGreaterThanOrEqual(CHIP_MIN_PX);
    }
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) expect(chipSizeNear(size, zoom, nearest.get(id))).toBe(size);
  });

  it('leaves a chip that clears its neighbour alone, however much nearer than the floor\'s spacing', () => {
    expect(chipSizeNear(30, 1, 31)).toBe(30);
    expect(chipSizeNear(30, 1, 29)).toBe(29 * 0.9);
  });

  it('never grows a chip, and keeps a mark you can click however close two desks sit', () => {
    expect(chipSizeNear(20, 1, 500)).toBe(20);
    expect(chipSizeNear(40, 1, 2)).toBe(CHIP_MIN_PX);
    expect(chipSizeNear(40, 1, undefined)).toBe(40);
  });
});

describe('chipPitch: a few spaces far apart and a tight column (Test Floor 1)', () => {
  // ENEC's Test Floor 1, read off its print preview (2026-11-17): four spaces 200–300 plan px from
  // anything, and four desks in a column 50 px apart. Its median gap is the far one.
  const pts = [
    { id: 'test4', x: 213, y: 331 }, { id: 'hot', x: 508, y: 425 }, { id: 'test', x: 823, y: 365 }, { id: 'test1', x: 198, y: 792 },
    { id: 'c1', x: 530, y: 680 }, { id: 'c2', x: 530, y: 735 }, { id: 'c3', x: 530, y: 785 }, { id: 'c4', x: 530, y: 835 },
  ];
  const column = ['c1', 'c2', 'c3', 'c4'];
  const nearest = nearestDistances(pts);
  const sizeAt = (zoom: number) => chipScreenSize(zoom, chipPitch(pts) * CHIP_FOOTPRINT_OF_PITCH);

  it('sized by the median, the chips at 53% were over twice the column\'s gap — the overlap that was reported', () => {
    expect(deskPitch(pts)).toBeGreaterThan(200);
    expect(chipScreenSize(0.53, deskPitch(pts) * CHIP_FOOTPRINT_OF_PITCH)).toBeGreaterThan(2 * 50 * 0.53);
  });

  it('follows the column instead: a little past its 50px, not the far gap', () => {
    expect(chipPitch(pts)).toBeCloseTo(50 * 1.25, 5);
  });

  it('draws every chip 24px zoomed out, as the print does, with room between the column\'s', () => {
    expect(sizeAt(0.53)).toBe(CHIP_PX);
    for (const id of column) expect(chipSizeNear(sizeAt(0.53), 0.53, nearest.get(id))).toBe(CHIP_PX);
  });

  it('grows with the drawing zoomed in, the column still clear of each other, up to the most a chip grows', () => {
    expect(sizeAt(1.36)).toBeGreaterThan(CHIP_PX);
    expect(sizeAt(1.36)).toBeLessThan(50 * 1.36 * 0.6);
    expect(sizeAt(2.82)).toBe(CHIP_PX * CHIP_MAX_SCALE);
  });

  it('gives an evenly laid floor its median, as before', () => {
    // Rows and columns 28px apart, each desk a few px off its spot, as a drawn floor is.
    const grid = Array.from({ length: 60 }, (_, i) => {
      const [c, r] = [i % 10, Math.floor(i / 10)];
      return { id: `g${i}`, x: c * 28 + ((c * 7 + r * 3) % 9) - 4, y: r * 28 + ((c * 5 + r * 2) % 9) - 4 };
    });
    const nn = [...nearestDistances(grid).values()].sort((a, b) => a - b);
    expect(nn[Math.floor(nn.length / 4)]).toBeLessThan(0.9 * nn[Math.floor(nn.length / 2)]);
    expect(chipPitch(grid)).toBe(deskPitch(grid));
  });

  it('is not moved by one stray pair: a quarter of the floor must sit that close', () => {
    const floor = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, x: (i % 5) * 200, y: Math.floor(i / 5) * 200 }));
    floor.push({ id: 'p1', x: 400, y: 600 }, { id: 'p2', x: 410, y: 600 });
    expect(chipPitch(floor)).toBe(deskPitch(floor));
  });
});
