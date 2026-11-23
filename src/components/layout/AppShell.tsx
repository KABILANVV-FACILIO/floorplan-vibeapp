import { useRef } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { canSee } from '../../state/selectors';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { BottomNav } from './BottomNav';
import { MapStage } from './MapStage';
import { SettingsScreen } from '../settings/SettingsScreen';
import { BookingsView } from '../bookings/BookingsView';
import { PeopleView } from '../people/PeopleView';
import { BookingModal } from '../details/BookingModal';
import { MobileApp } from '../mobile/MobileApp';
import { PrintSheet } from '../print/PrintSheet';
import { PrintController } from '../print/PrintController';
import { Toast } from '../primitives/Toast';
import { ErrorBoundary } from '../primitives/ErrorBoundary';
import styles from './AppShell.module.css';

/** What each view is called in "Couldn't show …" when it fails to draw. */
const VIEW_LABEL: Record<string, string> = { map: 'the floor plan', bookings: 'the bookings', people: 'the people list', settings: 'the settings' };

/**
 * The app's frame. Each surface draws inside an ErrorBoundary: a render error in one (React 18
 * unmounts the whole root on an uncaught one) used to blank the entire app. Now the surface that
 * failed shows a short notice in its place, the user is told, and everything around it — the
 * bottom navigation, the toasts — keeps working. Each boundary clears when what it shows changes
 * (its `resetKey`: the view, the floor, the plan type), so moving on tries it again.
 */
export function AppShell() {
  const { state, actions } = useFloorplanData();
  const isMobileViewport = useMediaQuery('(max-width: 720px)');
  const stageRef = useRef<HTMLDivElement>(null);
  const failed = (label: string) => (message: string) => actions.showToast(`Something went wrong showing ${label} — ${message}`, 6000);
  // The booking form is an overlay: failed, it shows nothing and is closed, so the next one opens clean.
  const formFailed = (message: string) => {
    failed('the booking form')(message);
    actions.closeBookingForm();
  };
  const bookingForm = (
    <ErrorBoundary silent label="the booking form" resetKey={state.bookModalOpen ? 'open' : 'closed'} onError={formFailed}>
      <BookingModal />
    </ErrorBoundary>
  );
  // Hidden on screen; what the browser prints. A failure here must not take the app down either.
  const printSheet = (
    <ErrorBoundary silent label="the print sheet" resetKey={`${state.floorId}:${state.planId}`} onError={failed('the print sheet')}>
      <PrintSheet />
    </ErrorBoundary>
  );

  if (state.loading && state.portfolio.length === 0) {
    return (
      <div className={[styles.loading, 'fp-screen'].join(' ')}>
        <div className={styles.spinner} />
      </div>
    );
  }

  if (isMobileViewport) {
    return (
      <>
        <div className={[styles.mobileRoot, 'fp-screen'].join(' ')}>
          <ErrorBoundary label="the floor plan" resetKey={`${state.mobileTab}:${state.floorId}:${state.planId}`} onError={failed('the floor plan')}>
            <MobileApp mode="page" />
          </ErrorBoundary>
          {bookingForm}
          <Toast message={state.toast} />
        </div>
        {printSheet}
      </>
    );
  }

  return (
    <PrintController>
      <div className={[styles.root, 'fp-screen'].join(' ')}>
      <ErrorBoundary
        label={VIEW_LABEL[state.activeView] ?? 'this view'}
        resetKey={`${state.activeView}:${state.floorId}:${state.planId}`}
        onError={failed(VIEW_LABEL[state.activeView] ?? 'this view')}
      >
        {state.activeView === 'settings' ? (
          <SettingsScreen />
        ) : state.activeView === 'bookings' && canSee(state, 'bookings') ? (
          <BookingsView />
        ) : state.activeView === 'people' ? (
          <PeopleView />
        ) : (
          <MapStage stageRef={stageRef} />
        )}
      </ErrorBoundary>
      <BottomNav />
      {bookingForm}
      <Toast message={state.toast} />
      </div>
      {/* Paper view. Hidden on screen; it is what the browser's own File › Print prints. Cmd+P is
          taken over to print through the print viewer instead (PrintController). */}
      {printSheet}
    </PrintController>
  );
}
