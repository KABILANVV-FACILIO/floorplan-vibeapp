/**
 * Who is hosting this page. Decides whether the connected-app bridge can answer at all, and which
 * dialect of it to speak — the Facilio web page and the Facilio mobile app host connected apps
 * differently, and the SDK (`FacilioAppSDK`) itself tells them apart the same way this does.
 *
 * - `iframe`: a parent frame exists — the Facilio web page, which answers over `window.parent`.
 * - `mobile`: the Facilio mobile app's React Native WebView injected `window.ReactNativeWebView`
 *   before the page ran; the SDK posts to that object and the host replies by dispatching a
 *   `MessageEvent` on the window. There is NO parent frame here — the page is the top window.
 * - `none`: opened as a plain tab. Nothing can answer a handshake, so the V3 tier gives up at once.
 */
export type HostKind = 'iframe' | 'mobile' | 'none';

export interface HostSignals {
  /** `window.self !== window.top`: something framed this page. */
  hasParentFrame: boolean;
  /** `window.ReactNativeWebView` exists: the mobile app's WebView bridge is in the page. */
  hasReactNativeBridge: boolean;
}

/**
 * The bridge wins over the frame check, as it does in the SDK (`_isMobile = !!window.ReactNativeWebView`):
 * a mobile WebView is the top window, so "no parent frame" there means nothing on its own.
 */
export function detectHostKind(signals: HostSignals): HostKind {
  if (signals.hasReactNativeBridge) return 'mobile';
  if (signals.hasParentFrame) return 'iframe';
  return 'none';
}

export function readHostSignals(w: Window | undefined = typeof window === 'undefined' ? undefined : window): HostSignals {
  if (!w) return { hasParentFrame: false, hasReactNativeBridge: false };
  return {
    hasParentFrame: w.self !== w.top,
    hasReactNativeBridge: !!(w as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView,
  };
}

export function currentHostKind(): HostKind {
  return detectHostKind(readHostSignals());
}

/**
 * The path form each host's `invokeFacilioAPI` joins correctly.
 *
 * The web hosts (facilio-ui `connected-app/instance.js`, facilio-mfe-client `event-bus.ts`) accept
 * both `v3/…` and `/v3/…` — they test for either prefix, and `@facilio/api` collapses the slash
 * against its `/api` base. The live web app has always sent the leading slash, so that stays.
 *
 * The mobile host (facilio-mobile-connected-app `serializer/request.ts`) builds the URL as
 * `/api/${url}` with no normalisation: a leading slash there yields `/api//v3/…`. Its own tests
 * send `v3/modules/workorder`, so on mobile the path goes bare.
 */
export function bridgeApiPath(path: string, host: HostKind): string {
  const bare = path.replace(/^\/+/, '');
  return host === 'mobile' ? bare : `/${bare}`;
}
