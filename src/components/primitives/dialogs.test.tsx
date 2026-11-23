import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';
import { PromptDialog } from './PromptDialog';
import { FloatingPanel } from './FloatingPanel';
import { escapeHtml, transitionCommentData } from '../details/transitionComment';

/**
 * The app's own "are you sure?" and "type a comment" dialogs, which replaced the browser's
 * confirm() and prompt() — both of which a sandboxed frame or a WebView answers at once with
 * "no" / null, so the action silently did nothing there.
 */
afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('starts on the way out, so a stray Enter backs out rather than confirms', () => {
    render(<ConfirmDialog title="Vacate WS-01?" confirmLabel="Vacate WS-01" onConfirm={() => {}} onCancel={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('confirms once on its button, and backs out on Cancel, Escape and the X', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="Cancel this booking?" confirmLabel="Cancel booking" cancelLabel="Keep booking" onConfirm={onConfirm} onCancel={onCancel}>
        It is cancelled in Facilio.
      </ConfirmDialog>
    );
    expect(screen.getByRole('dialog').textContent).toContain('It is cancelled in Facilio.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep booking' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('can hold its confirm back while the record is busy elsewhere', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Vacate?" confirmLabel="Vacate" disabled onConfirm={onConfirm} onCancel={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Vacate' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe('PromptDialog', () => {
  it('ties its label to the field, focuses it, and hands over exactly what was typed', () => {
    const onSubmit = vi.fn();
    render(<PromptDialog title="Block WS-01" label="Comment for “Block”" confirmLabel="Block" onSubmit={onSubmit} onCancel={() => {}} />);
    const field = screen.getByLabelText('Comment for “Block”');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'line one\nline two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
  });

  it('cancels without submitting', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<PromptDialog title="Block" label="Comment" onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('a workflow comment reaches Facilio as text, never as markup', () => {
  it('escapes & < > " \' for the HTML body', () => {
    expect(escapeHtml('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(escapeHtml(`a & "b" 'c'`)).toBe('a &amp; &quot;b&quot; &#39;c&#39;');
  });

  it('keeps the typed text as the plain body, and its line breaks in the HTML one', () => {
    expect(transitionCommentData('<img src=x onerror=alert(1)>\nok')).toEqual({
      transitionCommentData: { body: '<img src=x onerror=alert(1)>\nok', bodyHTML: '&lt;img src=x onerror=alert(1)&gt;<br>ok' },
    });
  });
});

/** A floating panel collapsed from the keyboard could not be opened again from it: it was a div. */
describe('a collapsed floating panel', () => {
  it('is a button, named for the panel, that opens it from the keyboard', () => {
    const onIconClick = vi.fn();
    render(
      <FloatingPanel x={0} y={0} open={false} width={300} maxHeight={400} title="Location" icon={<span />} onHeaderDown={() => {}} onToggle={() => {}} onIconDown={() => {}} onIconClick={onIconClick}>
        <p>Body</p>
      </FloatingPanel>
    );
    const dock = screen.getByRole('button', { name: 'Open Location' });
    expect(dock.tagName).toBe('BUTTON');
    fireEvent.click(dock);
    expect(onIconClick).toHaveBeenCalledTimes(1);
  });

  it('names its collapse control when open', () => {
    render(
      <FloatingPanel x={0} y={0} open width={300} maxHeight={400} title="Location" icon={<span />} onHeaderDown={() => {}} onToggle={() => {}} onIconDown={() => {}} onIconClick={() => {}}>
        <p>Body</p>
      </FloatingPanel>
    );
    expect(screen.getByRole('button', { name: 'Collapse Location' })).toBeTruthy();
  });
});
