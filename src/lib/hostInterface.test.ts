import { describe, expect, it, vi } from 'vitest';
import { callHostInterface } from './hostInterface';

/**
 * The host routes `interface.<name>` messages it doesn't handle itself to Facilio's own handler
 * (where getUrlProps / pushUrlProps live), but sends `interface.trigger` to the widget's actions.
 * These pin that the url actions go out as `interface.<name>` — the first version sent them through
 * `interface.trigger` and they never reached the host.
 */

describe('calling a host interface action', () => {
  it('posts interface.<name> with the params, through the SDK request/reply plumbing', async () => {
    const post = vi.fn().mockResolvedValue({ isSuccess: true, data: true });
    const trigger = vi.fn();
    const app = { _postMessageWithPromise: post, interface: { trigger } };

    await expect(callHostInterface(app, 'pushUrlProps', { query: { floorId: '4417' } })).resolves.toEqual({ isSuccess: true, data: true });
    expect(post).toHaveBeenCalledWith('interface.pushUrlProps', { query: { floorId: '4417' } });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("hands back the host's answer as it is — getUrlProps answers { query }", async () => {
    const app = { _postMessageWithPromise: vi.fn().mockResolvedValue({ query: { floorId: '4417' } }) };
    await expect(callHostInterface(app, 'getUrlProps')).resolves.toEqual({ query: { floorId: '4417' } });
    expect(app._postMessageWithPromise).toHaveBeenCalledWith('interface.getUrlProps', {});
  });

  it('uses a named SDK method when the private one is gone', async () => {
    const pushUrlProps = vi.fn().mockReturnValue('ok');
    await expect(callHostInterface({ interface: { pushUrlProps } }, 'pushUrlProps', { query: { floorId: '1' } })).resolves.toBe('ok');
    expect(pushUrlProps).toHaveBeenCalledWith({ query: { floorId: '1' } });
  });

  it('fails plainly when the SDK can send neither', async () => {
    await expect(callHostInterface({ interface: {} }, 'pushUrlProps')).rejects.toThrow(/cannot send interface.pushUrlProps/);
  });
});
