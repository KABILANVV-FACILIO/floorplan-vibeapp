import { useRef } from 'react';
import type { AppState } from './types';

/** The parts of the state that only say where the plan is on screen — a pan or zoom changes these and nothing else. */
export const VIEW_KEYS: ReadonlySet<keyof AppState> = new Set<keyof AppState>(['view', 'viewAnim', 'userZoomed']);

/**
 * The state as far as everything except the plan's position is concerned: the same object back
 * until something other than the view changes.
 *
 * A pan or zoom dispatches to the store like any other change, so every component reading the
 * store re-rendered on every pan frame — the 400-row sidebar, the people list, the toolbar — for
 * a change none of them could see. Components read the store through this instead (see
 * useFloorplanData), and a pan re-renders only what draws the plan.
 */
export function useDataState(state: AppState): AppState {
  const ref = useRef(state);
  const prev = ref.current;
  if (prev !== state) {
    for (const k of Object.keys(state) as (keyof AppState)[]) {
      if (!VIEW_KEYS.has(k) && state[k] !== prev[k]) {
        ref.current = state;
        break;
      }
    }
  }
  return ref.current;
}
