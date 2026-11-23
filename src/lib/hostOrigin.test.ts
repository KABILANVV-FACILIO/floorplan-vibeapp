import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Facilio page that hosts this app hands its origin over on the URL (`?origin=`), and every
 * "open the record in Facilio" link is built on it. The URL is anyone's to write, so the value is
 * taken only when it is a Facilio host (every region) or exactly the page embedding this one (an org
 * on its own domain); anything else falls back to the page's own origin. And a malformed value must
 * never throw at module load — that blanked the whole app.
 */

vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { trustedHostOrigin } = await import('./facilioApi');

describe('the host origin from the URL', () => {
  it('takes an https Facilio host, in every region, as its origin', () => {
    for (const host of ['app.facilio.com', 'enec.facilio.co.ae', 'app.facilio.ae', 'pre-app-stage2.facilio.in', 'app.facilio.us', 'app.facilio.co.uk', 'app.facilio.com.au', 'facilio.com']) {
      expect(trustedHostOrigin(`https://${host}/maintenance/home`, null)).toBe(`https://${host}`);
    }
  });

  it('refuses another site, a look-alike, plain http and other schemes', () => {
    for (const raw of ['https://evil.example', 'https://facilio.com.evil.example', 'https://evil-facilio.com', 'http://app.facilio.com', 'javascript:alert(1)', 'data:text/html,hi']) {
      expect(trustedHostOrigin(raw, null)).toBeNull();
    }
  });

  it('takes an org on its own domain only when that is the page actually embedding this one', () => {
    expect(trustedHostOrigin('https://cafm.example-org.ae', 'https://cafm.example-org.ae')).toBe('https://cafm.example-org.ae');
    expect(trustedHostOrigin('https://cafm.example-org.ae', 'https://elsewhere.example')).toBeNull();
  });

  it('answers null, without throwing, for a malformed or missing value', () => {
    for (const raw of ['%%%', 'not a url', '', null, undefined]) expect(trustedHostOrigin(raw, null)).toBeNull();
  });
});

describe('the record links, built at load', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.resetModules();
  });

  const loadWith = async (search: string) => {
    window.history.replaceState(null, '', `/${search}`);
    vi.resetModules();
    return import('./facilioApi');
  };

  it('fall back to the page’s own origin for a crafted origin — and loading does not throw', async () => {
    const mod = await loadWith('?capp_id=12&origin=https://evil.example');
    expect(mod.apiOrigin).toBe(window.location.origin);
    expect(mod.facilioRecordUrl('employee', 9)).toBe(`${window.location.origin}/maintenance/goto/summary/employee/9`);
  });

  it('survive a malformed origin', async () => {
    const mod = await loadWith('?capp_id=12&origin=%%%');
    expect(mod.apiOrigin).toBe(window.location.origin);
  });

  it('point at the Facilio host the URL names', async () => {
    const mod = await loadWith('?capp_id=12&origin=https://enec.facilio.co.ae');
    expect(mod.facilioRecordUrl('desks', 5001)).toBe('https://enec.facilio.co.ae/maintenance/goto/summary/desks/5001');
  });
});
