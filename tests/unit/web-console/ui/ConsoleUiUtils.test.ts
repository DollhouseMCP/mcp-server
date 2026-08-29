import { afterEach, describe, expect, it } from '@jest/globals';
import { JSDOM } from 'jsdom';

import { canonicalConsolePath } from '../../../../src/web-console/ui/console-meta';
import { confirmDialog, escapeHtml, relAgo } from '../../../../src/web-console/ui/ui-utils';

describe('web-console UI utilities', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
  });

  it.each([
    ['me/profile?view=full', '/api/v1/me/profile'],
    ['/me/profile#security', '/api/v1/me/profile'],
    ['/api/v1/me/profile?view=full', '/api/v1/me/profile'],
    ['/api/v1', '/api/v1'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(canonicalConsolePath(input)).toBe(expected);
  });

  it('escapes text consistently for HTML content and attributes', () => {
    expect(escapeHtml(`<button title="it's">Save & close</button>`))
      .toBe('&lt;button title=&quot;it&#39;s&quot;&gt;Save &amp; close&lt;/button&gt;');
  });

  it('formats relative timestamps and rejects invalid timestamps', () => {
    const now = Date.parse('2026-07-24T12:00:00.000Z');
    expect(relAgo('2026-07-24T11:59:30.000Z', now)).toBe('just now');
    expect(relAgo('2026-07-24T11:45:00.000Z', now)).toBe('15m ago');
    expect(relAgo('not-a-date', now)).toBe('unknown');
  });

  it('renders escaped confirmation content and removes its key listener on completion', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button></body>');
    const document = dom.window.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: document,
    });
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();

    const result = confirmDialog('<Disconnect & revoke?>', '"Disconnect"');
    const dialog = document.querySelector('[role="dialog"]');
    const labelId = dialog?.getAttribute('aria-labelledby');
    expect(labelId).toBe('confirm-modal-message');
    expect(document.getElementById(labelId ?? '')?.textContent).toBe('<Disconnect & revoke?>');
    expect(document.querySelector('.confirm-msg')?.textContent).toBe('<Disconnect & revoke?>');
    expect(document.querySelector('[data-confirm="1"]')?.textContent).toBe('"Disconnect"');
    expect(document.activeElement).toBe(document.querySelector('[data-confirm="1"]'));

    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab' }));
    expect(document.activeElement).toBe(document.querySelector('[data-confirm="0"]'));
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
    expect(document.activeElement).toBe(document.querySelector('[data-confirm="1"]'));

    (document.querySelector('[data-confirm="1"]') as HTMLButtonElement).click();

    await expect(result).resolves.toBe(true);
    expect(document.getElementById('confirm-modal')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
