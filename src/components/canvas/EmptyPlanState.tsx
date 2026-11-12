import { useFloorplanData } from '../../state/FloorplanContext';
import { canEdit, floorMeta } from '../../state/selectors';
import { PLAN_TYPE_MAPS, PLAN_TYPE_NAME } from '../../lib/types';
import { EmptyFloorArt } from '../primitives/EmptyFloorArt';

/**
 * A floor with no plan.
 *
 * No Upload button here. Adding a plan is editing the floor, and it lives in Edit mode — the Edit
 * panel carries Upload, and opening it there puts the person straight into the editor for the plan
 * they added. This screen is what everyone sees, most of whom cannot edit at all, so it says what
 * is missing and, only to those who can fix it, where to go.
 */
export function EmptyPlanState() {
  const { state } = useFloorplanData();
  const floor = floorMeta(state, state.floorId)?.floor;
  const planName = PLAN_TYPE_NAME[state.planId];
  const editor = canEdit(state);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <EmptyFloorArt />
      <div>
        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink-900)', margin: '0 0 4px' }}>No {planName} floorplan yet</h3>
        <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--ink-600)', margin: 0, maxWidth: 340 }}>
          {editor
            ? `Open Edit to upload a plan for ${floor?.name ?? 'this floor'} and start mapping ${PLAN_TYPE_MAPS[state.planId]}.`
            : `A plan for ${floor?.name ?? 'this floor'} has not been added yet.`}
        </p>
      </div>
    </div>
  );
}
