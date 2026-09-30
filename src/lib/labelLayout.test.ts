import { describe, expect, it } from 'vitest';
import { cardOffset, planMarkerLabels, planRoomLabels } from './labelLayout';
import type { LabelPlacement, MarkerLabelInput, RoomLabelInput } from './labelLayout';

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
    expect(measured.w).toBe(90 + 12);
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

  it('drops the names of two small neighbouring rooms that would pile on each other — as on Block B 1F', () => {
    // Two toilets side by side, each ~3% of the plan wide: ~18px on screen, for a name ~150px wide.
    const shown = planRoomLabels([room('HQ-BKB-1F-Male Toilet', 0.4, 0.4, 0.03, 0.05), room('HQ-BKB-1F-Female Toilet', 0.43, 0.4, 0.03, 0.05)], fit);
    expect([...shown]).toEqual([]);
  });

  it("draws a room's name once zoomed in far enough for it to fit inside the room", () => {
    const toilet = room('WC', 0.4, 0.4, 0.03, 0.05);
    expect(planRoomLabels([toilet], fit).has('WC')).toBe(false);
    expect(planRoomLabels([toilet], { ...fit, zoom: 2 }).has('WC')).toBe(true);
  });

  it('keeps the bigger room when two names that fit their rooms would still overlap', () => {
    // Two rooms that overlap on screen (a room outlined inside another): the names collide.
    const shown = planRoomLabels([room('Open Office', 0.1, 0.1, 0.5, 0.5), room('Pod', 0.29, 0.32, 0.12, 0.06)], { ...fit, zoom: 1 });
    expect([...shown]).toEqual(['Open Office']);
  });

  it('always shows the selected room, and everything else yields to it', () => {
    const shown = planRoomLabels([room('Open Office', 0.1, 0.1, 0.5, 0.5), room('Pod', 0.29, 0.32, 0.12, 0.06, { must: true })], { ...fit, zoom: 1 });
    expect([...shown]).toEqual(['Pod']);
    expect(planRoomLabels([room('HQ-BKB-1F-Male Toilet', 0.4, 0.4, 0.03, 0.05, { must: true })], fit).size).toBe(1);
  });

  it('keeps every name on a roomy floor', () => {
    const shown = planRoomLabels([room('Board Room', 0.1, 0.1, 0.3, 0.3), room('Pantry', 0.6, 0.6, 0.3, 0.3)], { ...fit, zoom: 1 });
    expect([...shown].sort()).toEqual(['Board Room', 'Pantry']);
  });
});
