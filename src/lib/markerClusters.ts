/**
 * Group markers that are too close together on screen to be separate things.
 *
 * A marker keeps a constant SIZE on screen while its POSITION scales with the zoom, so on a phone
 * the arithmetic is brutal: a 1492px plan fitted into a ~340px card is drawn at z ≈ 0.22, which
 * puts a bank of desks 45 plan-px apart just 10px apart on glass — under a 22px chip. The result
 * is the pile on the mobile map: a clump of overlapping circles where no single one can be read,
 * tapped, or counted.
 *
 * Hiding the overlap is not an option — every one of those is a desk somebody may need. So a clump
 * becomes ONE thing that says how many it stands for, and zooming in splits it back apart. That is
 * the honest answer at that scale: the plan cannot show you twelve distinct desks in 40 pixels, and
 * a count says so out loud instead of drawing twelve circles on top of each other.
 *
 * Pure geometry — no DOM, no React — so the rules can be pinned by tests rather than by eye.
 */

export interface ClusterInput {
  id: string;
  /** Normalized position on the plan (0..1), the coordinates units are stored in. */
  x: number;
  y: number;
}

export interface Cluster {
  /** Stable across renders: the id of the first member in placement order. */
  key: string;
  /** Normalized centre of the group — the mean of its members. */
  x: number;
  y: number;
  ids: string[];
}

export interface ClusterOptions {
  /** The plan's intrinsic pixel size — normalized coordinates multiply up by these. */
  planW: number;
  planH: number;
  /** Current zoom. Screen distance between two markers is their plan distance times this. */
  zoom: number;
  /**
   * How far apart two markers must be ON SCREEN to stay separate, in px. Below this their chips
   * overlap, so they are the same blob to the eye and to a fingertip.
   */
  minGapPx: number;
}

/**
 * Cluster markers whose screen positions are closer than `minGapPx`.
 *
 * Single-member clusters are returned too, so the caller renders one list rather than two. Order
 * is stable — by position, then id — so the same floor at the same zoom always produces the same
 * grouping, and a cluster does not renumber itself when React re-renders.
 */
export function clusterMarkers(inputs: ClusterInput[], opts: ClusterOptions): Cluster[] {
  const { planW, planH, zoom, minGapPx } = opts;
  if (inputs.length === 0) return [];
  // Nothing to do when the markers cannot overlap at all.
  if (minGapPx <= 0) return inputs.map((i) => ({ key: i.id, x: i.x, y: i.y, ids: [i.id] }));

  const sx = (x: number) => x * planW * zoom;
  const sy = (y: number) => y * planH * zoom;

  const order = [...inputs].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));

  // Bucketed by the gap itself, so a candidate only ever compares against the nine cells that
  // could hold a cluster within reach.
  const cell = minGapPx;
  const buckets = new Map<string, Cluster[]>();
  const keyOf = (cx: number, cy: number) => `${Math.floor(cx / cell)}:${Math.floor(cy / cell)}`;
  const out: Cluster[] = [];

  for (const i of order) {
    const px = sx(i.x);
    const py = sy(i.y);
    const bx = Math.floor(px / cell);
    const by = Math.floor(py / cell);

    let best: Cluster | null = null;
    let bestDist = Infinity;
    for (let gx = bx - 1; gx <= bx + 1; gx++) {
      for (let gy = by - 1; gy <= by + 1; gy++) {
        for (const c of buckets.get(`${gx}:${gy}`) ?? []) {
          const dx = sx(c.x) - px;
          const dy = sy(c.y) - py;
          const dist = Math.hypot(dx, dy);
          if (dist < minGapPx && dist < bestDist) {
            best = c;
            bestDist = dist;
          }
        }
      }
    }

    if (best) {
      // The centre follows its members, so the bubble sits in the middle of the clump it stands
      // for rather than on whichever marker happened to be first.
      const n = best.ids.length;
      const oldKey = keyOf(sx(best.x), sy(best.y));
      best.x = (best.x * n + i.x) / (n + 1);
      best.y = (best.y * n + i.y) / (n + 1);
      best.ids.push(i.id);
      // Re-bucket if the moved centre now belongs to a different cell.
      const newKey = keyOf(sx(best.x), sy(best.y));
      if (newKey !== oldKey) {
        const from = buckets.get(oldKey);
        if (from) {
          const at = from.indexOf(best);
          if (at >= 0) from.splice(at, 1);
        }
        const to = buckets.get(newKey);
        if (to) to.push(best);
        else buckets.set(newKey, [best]);
      }
      continue;
    }

    const made: Cluster = { key: i.id, x: i.x, y: i.y, ids: [i.id] };
    out.push(made);
    const k = keyOf(px, py);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(made);
    else buckets.set(k, [made]);
  }

  return out;
}

/**
 * The zoom at which a cluster's members clear `minGapPx` and it stops being a cluster — what
 * tapping one should zoom to. Capped by the caller against the view's own maximum.
 */
export function zoomToSplit(cluster: Cluster, inputs: Map<string, ClusterInput>, opts: ClusterOptions): number {
  const { planW, planH, zoom, minGapPx } = opts;
  if (cluster.ids.length < 2) return zoom;
  // The tightest pair in the group decides it: anything looser is already separate by then.
  let tightest = Infinity;
  for (let a = 0; a < cluster.ids.length; a++) {
    for (let b = a + 1; b < cluster.ids.length; b++) {
      const p = inputs.get(cluster.ids[a]);
      const q = inputs.get(cluster.ids[b]);
      if (!p || !q) continue;
      const d = Math.hypot((p.x - q.x) * planW, (p.y - q.y) * planH);
      if (d > 0 && d < tightest) tightest = d;
    }
  }
  if (!Number.isFinite(tightest) || tightest === 0) return zoom * 2;
  return (minGapPx / tightest) * 1.05;
}
