import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { isVibeApp } from './lib/vibe';
import { isConnectedApp, isFacilioApiConfigured } from './lib/facilioApi';
import './styles/global.css';

// Deployed only: the route-rescue worker (public/sw.js) that makes /bookings, /people and
// /settings survive refresh/deep-links on the vibe static host — see the comment in sw.js.
// Skipped in dev, where the vite server handles SPA fallback itself and a worker would only
// interfere with HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// First line in the console on every load: which build this is, and which runtime it decided it is
// in. Both are otherwise invisible in a deployed, SSO-gated app.
// eslint-disable-next-line no-console
console.info(
  `[floorplan] build ${__BUILD_STAMP__} | vibe=${isVibeApp} connectedApp=${isConnectedApp} apiConfigured=${isFacilioApiConfigured} embedded=${window.self !== window.top}`
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
