import type { CSSProperties, ReactNode } from 'react';
import type { ResponderIcon, ResponderRoleDef } from '../../lib/types';
import { badgeLetters } from '../../lib/firstResponders';

/** The trefoil, built from three 60° blades round a hub — drawn, not approximated, so it reads as itself. */
function trefoil(): string {
  const c = 8;
  const r0 = 2.1;
  const r1 = 5.4;
  const pt = (r: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
  };
  return [-90, 30, 150]
    .map((mid) => {
      const a = mid - 30;
      const b = mid + 30;
      return `M${pt(r0, a)}L${pt(r1, a)}A${r1} ${r1} 0 0 1 ${pt(r1, b)}L${pt(r0, b)}A${r0} ${r0} 0 0 0 ${pt(r0, a)}Z`;
    })
    .join('');
}
const TREFOIL = trefoil();

/** Each symbol in white, on a 16-unit badge. `color` is the badge's own, for cut-outs. */
function symbol(icon: ResponderIcon, color: string, letters: string): ReactNode {
  switch (icon) {
    case 'cross':
      return <path d="M6.4 3.6h3.2v2.8h2.8v3.2H9.6v2.8H6.4V9.6H3.6V6.4h2.8z" fill="#fff" />;
    case 'warden':
      return <path d="M3.9 5.2h1.7l1 4 1-3.6h1l1 3.6 1-4h1.7l-1.9 6.1h-1.4L8 7.8l-1 3.5H5.6z" fill="#fff" />;
    case 'flame':
      return <path d="M8 2.6c.3 1.6 1.6 2.5 2.4 3.6.8 1.1 1.2 2.1 1.2 3.2A3.6 3.6 0 0 1 8 13a3.6 3.6 0 0 1-3.6-3.6c0-1.3.6-2.3 1.3-3 .1.9.6 1.5 1.3 1.8-.2-1.9.2-3.9 1-5.6z" fill="#fff" />;
    case 'aed':
      return (
        <>
          <path d="M8 13.1 3.8 9.1A2.7 2.7 0 0 1 8 5.6a2.7 2.7 0 0 1 4.2 3.5z" fill="#fff" />
          <path d="M8.7 6.3 6.8 9.1h1.5l-.9 2.4 2.4-3.3H8.4l.9-1.9z" fill={color} />
        </>
      );
    case 'shield':
      return <path d="M8 2.8l4.2 1.6v3.4c0 2.6-1.8 4.5-4.2 5.4-2.4-.9-4.2-2.8-4.2-5.4V4.4z" fill="#fff" />;
    case 'megaphone':
      return <path d="M3.4 6.5h1.9l5.1-2.8v8.6L5.3 9.5H3.4zM5.8 9.9l.8 2.7h1.5l-.7-2.3zM11.4 6.4h1.4v3.2h-1.4z" fill="#fff" />;
    case 'radiation':
      return (
        <>
          <path d={TREFOIL} fill="#fff" />
          <circle cx="8" cy="8" r="1.2" fill="#fff" />
        </>
      );
    case 'drop':
      return <path d="M8 2.8c1.9 2.6 3.6 4.6 3.6 6.6a3.6 3.6 0 0 1-7.2 0c0-2 1.7-4 3.6-6.6z" fill="#fff" />;
    case 'star':
      return <path d="M8 2.9l1.5 3.1 3.4.5-2.5 2.4.6 3.4L8 10.7l-3 1.6.6-3.4-2.5-2.4 3.4-.5z" fill="#fff" />;
    case 'phone':
      return <path d="M5.2 3.4l1.6-.4.9 2.4-1 .8a6 6 0 0 0 3.1 3.1l.8-1 2.4.9-.4 1.6c-.1.5-.6.8-1.1.8C7.1 11.4 4.6 8.9 4.4 4.5c0-.5.3-1 .8-1.1z" fill="#fff" />;
    case 'bell':
      return <path d="M8 2.8a3.2 3.2 0 0 1 3.2 3.2v2.6l1.1 1.6H3.7l1.1-1.6V6A3.2 3.2 0 0 1 8 2.8zM6.6 11.2h2.8a1.4 1.4 0 0 1-2.8 0z" fill="#fff" />;
    case 'text':
      return (
        <text x="8" y={letters.length > 1 ? 10.5 : 11.1} textAnchor="middle" fill="#fff" style={{ font: `800 ${letters.length > 1 ? 6.6 : 8.6}px/1 var(--font-sans, system-ui, sans-serif)` }}>
          {letters}
        </text>
      );
  }
}

/**
 * A responder role's mark: a white symbol on the role's colour, inside the role's shape. Built-in,
 * the first-aid sign's cross on a green square and a warden's W on a red disc; an org's own role
 * picks its symbol, colour and shape in Settings. Shape is a second cue besides colour, so two
 * roles stay apart for someone who can't tell their colours apart. The white ring keeps the badge
 * legible on any chip — free, assigned, or a department's colour.
 */
export function ResponderGlyph({ role, size = 12 }: { role: ResponderRoleDef; size?: number }) {
  const letters = role.icon === 'text' ? badgeLetters(role.text, role.name) : '';
  const shape =
    role.shape === 'square' ? (
      <rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3.2" fill={role.color} stroke="#fff" strokeWidth="1.5" />
    ) : role.shape === 'diamond' ? (
      <path d="M8 .7 15.3 8 8 15.3.7 8z" fill={role.color} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
    ) : (
      <circle cx="8" cy="8" r="7.25" fill={role.color} stroke="#fff" strokeWidth="1.5" />
    );
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      {shape}
      {/* A diamond's middle is narrower: its symbol is drawn a little smaller to sit inside. */}
      <g transform={role.shape === 'diamond' ? 'translate(8 8) scale(0.74) translate(-8 -8)' : undefined}>{symbol(role.icon, role.color, letters)}</g>
    </svg>
  );
}

/** Corners in the order badges fill them: the first role top right, the next top left, then below. */
const CORNERS = [
  { top: true, right: true },
  { top: true, right: false },
  { top: false, right: true },
  { top: false, right: false },
];

/**
 * The badges on a desk chip, one per role the occupant holds, in the org's role order — up to four,
 * one per corner. Sized off the chip (the parent), so they grow and shrink with it; they reach a
 * little past its corners so they never cover the occupant's initials.
 */
export function ResponderBadges({ roles, chip }: { roles: ResponderRoleDef[]; chip: number }) {
  if (roles.length === 0) return null;
  const size = Math.round(chip * 0.58);
  const off = -size * 0.45;
  const at = (i: number): CSSProperties => {
    const c = CORNERS[i];
    return {
      position: 'absolute',
      ...(c.top ? { top: off } : { bottom: off }),
      ...(c.right ? { right: off } : { left: off }),
      pointerEvents: 'none',
      filter: 'drop-shadow(0 1px 1px rgba(16,24,40,0.28))',
    };
  };
  return (
    <>
      {roles.slice(0, CORNERS.length).map((role, i) => (
        <span key={role.id} style={at(i)} data-responder={role.id}>
          <ResponderGlyph role={role} size={size} />
        </span>
      ))}
    </>
  );
}
