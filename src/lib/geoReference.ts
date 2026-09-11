/**
 * Real Facilio floorplan markers are positioned in actual lng/lat, georeferenced to the raster
 * floorplan image via a 4-corner quad (`indoorfloorplan.geometry`) — normally set by a human
 * dragging the image onto a real map in the Facilio editor. This app has no such calibration
 * step and doesn't track a site's real-world address, so on upload it invents a small, SYNTHETIC
 * quad (anchored at an arbitrary placeholder point, sized to a plausible single-floor footprint,
 * matching the image's aspect ratio) — self-consistent for converting this app's 0-1 unit
 * fractions to/from lng/lat, but not tied to any real geographic location.
 */
export interface GeoQuad {
  /** [lng, lat] corners in image order: top-left, top-right, bottom-right, bottom-left. */
  tl: [number, number];
  tr: [number, number];
  br: [number, number];
  bl: [number, number];
}

const SYNTHETIC_ANCHOR: [number, number] = [-122.4194, 37.7749];
const METERS_PER_DEG_LAT = 111320;
/** Plausible single-floor footprint — keeps the synthetic quad a sane real-world size. */
const TARGET_SPAN_METERS = 60;

export function computeSyntheticGeometry(width: number, height: number): GeoQuad {
  const longerSidePx = Math.max(width, height) || 1;
  const metersPerPixel = TARGET_SPAN_METERS / longerSidePx;
  const [anchorLng, anchorLat] = SYNTHETIC_ANCHOR;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((anchorLat * Math.PI) / 180);
  const lngSpan = (width * metersPerPixel) / metersPerDegLng;
  const latSpan = (height * metersPerPixel) / METERS_PER_DEG_LAT;
  return {
    tl: [anchorLng, anchorLat],
    tr: [anchorLng + lngSpan, anchorLat],
    br: [anchorLng + lngSpan, anchorLat - latSpan],
    bl: [anchorLng, anchorLat - latSpan],
  };
}

/** Fraction (0-1 of image width/height) -> [lng, lat], via bilinear interpolation across the quad. */
export function quadToLngLat(quad: GeoQuad, xFrac: number, yFrac: number): [number, number] {
  const top: [number, number] = [quad.tl[0] + (quad.tr[0] - quad.tl[0]) * xFrac, quad.tl[1] + (quad.tr[1] - quad.tl[1]) * xFrac];
  const bottom: [number, number] = [quad.bl[0] + (quad.br[0] - quad.bl[0]) * xFrac, quad.bl[1] + (quad.br[1] - quad.bl[1]) * xFrac];
  return [top[0] + (bottom[0] - top[0]) * yFrac, top[1] + (bottom[1] - top[1]) * yFrac];
}

/**
 * Inverse of `quadToLngLat`: [lng, lat] -> fraction (0-1 of image width/height).
 *
 * Solved with Newton iteration rather than algebraically. The forward map is bilinear, so for the
 * axis-aligned quads this app generates the inverse is plain linear interpolation — but a quad
 * calibrated by a human in the Facilio editor can be rotated or trapezoidal, where bilinear
 * inversion needs a quadratic. Newton handles both, converging in a handful of steps, and the
 * fallback on a degenerate (zero-area) quad is the centre rather than a NaN that would place a
 * marker nowhere.
 */
export function lngLatToQuadFraction(quad: GeoQuad, lng: number, lat: number): [number, number] {
  let x = 0.5;
  let y = 0.5;
  for (let i = 0; i < 12; i++) {
    const [px, py] = quadToLngLat(quad, x, y);
    const ex = px - lng;
    const ey = py - lat;
    if (Math.abs(ex) < 1e-12 && Math.abs(ey) < 1e-12) break;
    const dXdx = (quad.tr[0] - quad.tl[0]) * (1 - y) + (quad.br[0] - quad.bl[0]) * y;
    const dXdy = quad.bl[0] - quad.tl[0] + (quad.br[0] - quad.bl[0] - (quad.tr[0] - quad.tl[0])) * x;
    const dYdx = (quad.tr[1] - quad.tl[1]) * (1 - y) + (quad.br[1] - quad.bl[1]) * y;
    const dYdy = quad.bl[1] - quad.tl[1] + (quad.br[1] - quad.bl[1] - (quad.tr[1] - quad.tl[1])) * x;
    const det = dXdx * dYdy - dXdy * dYdx;
    if (!det) break;
    x -= (ex * dYdy - ey * dXdy) / det;
    y -= (-ex * dYdx + ey * dXdx) / det;
  }
  return [x, y];
}

export function quadToGeometryString(quad: GeoQuad): string {
  return JSON.stringify({ type: 'Polygon', coordinates: [[quad.tl, quad.tr, quad.br, quad.bl, quad.tl]] });
}

/** Inverse of `quadToGeometryString` — reads the corners back off a stored `indoorfloorplan.geometry` string. */
export function geometryStringToQuad(geometry: string | null | undefined): GeoQuad | null {
  if (!geometry) return null;
  try {
    const parsed = JSON.parse(geometry);
    const ring = parsed?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    return { tl: ring[0], tr: ring[1], br: ring[2], bl: ring[3] };
  } catch {
    return null;
  }
}

/** Reads an image data URL's actual pixel dimensions — used to size the synthetic geometry to the real upload's aspect ratio. */
export function measureImageDataUrl(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not measure image dimensions'));
    img.src = dataUrl;
  });
}
