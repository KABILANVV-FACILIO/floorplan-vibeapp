import { useFloorplanData } from '../../state/FloorplanContext';
import { usePanelDrag } from '../../hooks/usePanelDrag';
import { FloatingPanel } from '../primitives/FloatingPanel';
import { EditPanel } from './EditPanel';
import { AssignPanel } from './AssignPanel';
import { BookPanel } from './BookPanel';

const PANEL_WIDTH = 304;

const DetailsIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
  </svg>
);

const MODE_LABEL: Record<string, string> = { edit: 'Edit view', assign: 'Assignment view', book: 'Booking view' };

/** The panel's title: the plan's base view without the Assignment right is just the People list. */
function panelTitle(mode: string, assignOn: boolean): string {
  return mode === 'assign' && !assignOn ? 'People' : MODE_LABEL[mode];
}

export function DetailsPanel() {
  const { state } = useFloorplanData();
  const drag = usePanelDrag('details', PANEL_WIDTH);

  return (
    <>
      <FloatingPanel
        x={drag.x}
        y={drag.y}
        open={drag.open}
        width={PANEL_WIDTH}
        maxHeight={drag.maxH}
        title={panelTitle(state.mode, state.planViews.assign)}
        icon={DetailsIcon}
        zIndex={41}
        onHeaderDown={drag.onHeaderDown}
        onToggle={drag.onToggle}
        onIconDown={drag.onIconDown}
        onIconClick={drag.onIconClick}
      >
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, boxSizing: 'border-box' }}>
          {state.mode === 'edit' && <EditPanel />}
          {state.mode === 'assign' && <AssignPanel />}
          {state.mode === 'book' && <BookPanel />}
        </div>
      </FloatingPanel>
    </>
  );
}
