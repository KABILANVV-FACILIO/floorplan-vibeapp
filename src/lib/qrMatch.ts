import type { Unit } from './types';

/** Case, spaces, dashes and underscores don't distinguish two codes: "WS-07" = "ws 07" = "WS07". */
export function normalizeSpaceCode(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** The code a QR payload carries: a plain label or id, or a URL that names the space. */
export function spaceCodeOf(raw: string): string {
  const code = raw.trim();
  try {
    const url = new URL(code);
    return url.searchParams.get('qr') ?? url.searchParams.get('space') ?? url.searchParams.get('unit') ?? url.pathname.split('/').filter(Boolean).pop() ?? code;
  } catch {
    return code; // not a URL — the payload is the code
  }
}

export type SpaceMatch = { unit: Unit } | { unit: null; reason: 'none' | 'ambiguous' };

/**
 * The space a scanned code names — exactly, or not at all.
 *
 * Matching used to fall back to partial text, so "WS-107" found "WS-10" (one contains the other)
 * and opened a booking for the wrong desk, and a desk with no name matched every code there is
 * (every string contains the empty one). A scan that lands on the wrong space is worse than one
 * that finds nothing: the person books it without noticing. So the code must equal a space's name,
 * or failing that its id, after the separator-insensitive normalising above — and when two spaces
 * on the floor share it, neither is picked.
 */
export function matchSpaceCode(units: Unit[], raw: string): SpaceMatch {
  const target = normalizeSpaceCode(spaceCodeOf(raw));
  if (!target) return { unit: null, reason: 'none' };
  for (const key of [(u: Unit) => u.label, (u: Unit) => u.id]) {
    const hits = units.filter((u) => {
      const k = normalizeSpaceCode(key(u) ?? '');
      return k !== '' && k === target;
    });
    if (hits.length === 1) return { unit: hits[0] };
    if (hits.length > 1) return { unit: null, reason: 'ambiguous' };
  }
  return { unit: null, reason: 'none' };
}
