/**
 * The picture a floor with no plan shows, on the web and in the mobile app alike.
 *
 * A blank plan sheet with the outline of rooms not yet drawn on it — dashed, because they are not
 * there. One colour, from the brand tokens, at varying strength: it marks an absence, so it should
 * read as quiet rather than as an illustration competing for attention. Inline rather than an image
 * file, so a floor with nothing to load does not then wait on a request for its own placeholder.
 */
export function EmptyFloorArt({ size = 168 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 120) / 168} viewBox="0 0 168 120" fill="none" role="img" aria-label="No floorplan" style={{ color: 'var(--brand-indigo)', display: 'block' }}>
      {/* the sheet, with its corner turned */}
      <path d="M24 10h104l16 16v84a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6V16a6 6 0 0 1 6-6z" fill="var(--brand-indigo-050)" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" />
      <path d="M128 10v12a4 4 0 0 0 4 4h12" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" strokeLinejoin="round" />

      {/* a faint drafting grid */}
      <g stroke="currentColor" strokeOpacity="0.07" strokeWidth="1">
        {[34, 50, 66, 82, 98].map((y) => (
          <line key={`h${y}`} x1="26" x2="142" y1={y} y2={y} />
        ))}
        {[42, 62, 82, 102, 122].map((x) => (
          <line key={`v${x}`} x1={x} x2={x} y1="30" y2="108" />
        ))}
      </g>

      {/* rooms that have not been drawn yet */}
      <g stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="4 3.5" strokeLinejoin="round">
        <rect x="34" y="34" width="40" height="30" rx="2" />
        <rect x="82" y="34" width="46" height="30" rx="2" />
        <rect x="34" y="72" width="94" height="28" rx="2" />
      </g>

      {/* where a desk would go */}
      <g transform="translate(98 86)">
        <circle r="9" fill="var(--brand-indigo-050)" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
        <path d="M-4 0h8M0 -4v8" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </svg>
  );
}
