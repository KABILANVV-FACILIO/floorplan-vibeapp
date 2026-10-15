import { describe, expect, it, vi } from 'vitest';
import { NO_HOST_ASSIGN_MESSAGE, orgWritesUnavailable, refuseOrgWrite } from './orgWrites';

/**
 * Whether this page may write to the org. A deployed page with no Facilio host used to assign and
 * vacate in the browser alone and report it done; the org never received it.
 */

describe('can this page write to Facilio?', () => {
  it('no — deployed, but with no Facilio host to write through', () => {
    expect(orgWritesUnavailable(true, false)).toBe(true);
  });

  it('yes — inside Facilio or the mobile app', () => {
    expect(orgWritesUnavailable(true, true)).toBe(false);
  });

  it('not refused in plain local dev, where the browser copy is the whole job', () => {
    expect(orgWritesUnavailable(false, false)).toBe(false);
  });
});

describe('refusing a write the page cannot make', () => {
  it('says why, and tells the caller to stop', () => {
    const toast = vi.fn();
    expect(refuseOrgWrite(toast, true)).toBe(true);
    expect(toast).toHaveBeenCalledWith(NO_HOST_ASSIGN_MESSAGE, 8000);
    expect(NO_HOST_ASSIGN_MESSAGE).toMatch(/inside Facilio/);
  });

  it('stays out of the way when the write can be made', () => {
    const toast = vi.fn();
    expect(refuseOrgWrite(toast, false)).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});
