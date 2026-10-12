import { describe, expect, it } from 'vitest';
import { bridgeApiPath, detectHostKind, readHostSignals } from './hostKind';

describe('detectHostKind', () => {
  it('is "none" for a plain tab: no parent frame, no React Native bridge', () => {
    expect(detectHostKind({ hasParentFrame: false, hasReactNativeBridge: false })).toBe('none');
  });

  it('is "iframe" when a parent frame exists (the Facilio web page)', () => {
    expect(detectHostKind({ hasParentFrame: true, hasReactNativeBridge: false })).toBe('iframe');
  });

  it('is "mobile" when the React Native WebView bridge is in the page — even though it is the top window', () => {
    // The regression: the mobile WebView has no parent frame, and "no parent frame" used to mean
    // "nobody can answer", which rejected every V3 call before the SDK was even loaded.
    expect(detectHostKind({ hasParentFrame: false, hasReactNativeBridge: true })).toBe('mobile');
  });

  it('lets the bridge win when both signals are present, as the SDK does', () => {
    expect(detectHostKind({ hasParentFrame: true, hasReactNativeBridge: true })).toBe('mobile');
  });
});

describe('readHostSignals', () => {
  it('reads the frame and bridge signals off a window', () => {
    const top = {} as Window;
    const framed = { self: {} as Window, top } as unknown as Window;
    expect(readHostSignals(framed)).toEqual({ hasParentFrame: true, hasReactNativeBridge: false });

    const self = {} as Window;
    const mobile = { self, top: self, ReactNativeWebView: { postMessage() {} } } as unknown as Window;
    expect(readHostSignals(mobile)).toEqual({ hasParentFrame: false, hasReactNativeBridge: true });

    const plain = { self, top: self } as unknown as Window;
    expect(readHostSignals(plain)).toEqual({ hasParentFrame: false, hasReactNativeBridge: false });
  });

  it('is all-false with no window at all', () => {
    expect(readHostSignals(undefined)).toEqual({ hasParentFrame: false, hasReactNativeBridge: false });
  });
});

describe('bridgeApiPath', () => {
  it('keeps the leading slash for the web host, whichever form the caller used', () => {
    expect(bridgeApiPath('v3/modules/desks/12', 'iframe')).toBe('/v3/modules/desks/12');
    expect(bridgeApiPath('/v3/modules/desks/12', 'iframe')).toBe('/v3/modules/desks/12');
  });

  it('sends the bare path to the mobile host, which prefixes "/api/" itself', () => {
    expect(bridgeApiPath('v3/floorplan/getFloorplanDetailsByType?floorId=1', 'mobile')).toBe('v3/floorplan/getFloorplanDetailsByType?floorId=1');
    expect(bridgeApiPath('/v2/forms', 'mobile')).toBe('v2/forms');
    expect(bridgeApiPath('//v2/forms', 'mobile')).toBe('v2/forms');
  });

  it('treats a standalone open like the web form (there is nobody to send it to anyway)', () => {
    expect(bridgeApiPath('v2/account', 'none')).toBe('/v2/account');
  });
});
