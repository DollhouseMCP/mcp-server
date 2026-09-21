/* global document */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
const get = jest.fn<(...args: any[]) => Promise<any>>();
const post = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../../../src/web-console/ui/api', () => ({ get, post }));
let open: (id: string, route: (...args: string[]) => boolean) => void;
let dom: JSDOM;
const userId = randomUUID(), id = randomUUID();
const metadata = () => ({ id, user_id: userId, username: '<img src=x onerror=alert(1)>', email: 'invited@example.test',
  intended_roles: ['operator'], state: 'pending', generation: 1, expires_at: '2099-09-21T12:00:00.000Z' });
const reply = (state = 'pending') => ({ status: 200, body: { invitation: { ...metadata(), state } } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (name: string) => document.querySelector<HTMLButtonElement>(`#ua-il-${name}`)!;
const click = (name: string) => button(name).click();
const status = () => document.querySelector('#ua-il-status')!.textContent;
beforeAll(async () => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://console.example.test', pretendToBeVisual: true });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    addEventListener: { configurable: true, value: dom.window.addEventListener.bind(dom.window) },
    removeEventListener: { configurable: true, value: dom.window.removeEventListener.bind(dom.window) },
  });
  ({ openInvitationLifecycle: open } = await import('../../../../src/web-console/ui/invitation-lifecycle-ui'));
});
beforeEach(() => { document.body.replaceChildren(); get.mockReset(); post.mockReset(); get.mockResolvedValue(reply()); });
afterEach(() => dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide')));
afterAll(() => { dom.window.close(); for (const key of ['document', 'addEventListener', 'removeEventListener']) Reflect.deleteProperty(globalThis, key); });

it('opens only an advertised selected-account lookup, renders safe metadata and traps focus', async () => {
  open(userId, () => false); expect(get).not.toHaveBeenCalled();
  open('invalid', () => true); expect(get).not.toHaveBeenCalled();
  const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
  open(userId, (_method, path) => !path.endsWith('/revoke')); await tick();
  expect(get).toHaveBeenCalledWith(`/admin/accounts/users/${userId}/invitation`);
  expect(document.querySelector('#ua-il-details')!.textContent).toContain(metadata().username);
  expect(document.querySelector('#ua-il-details img')).toBeNull(); expect(button('revoke').hidden).toBe(true);
  expect(document.querySelector('input[aria-label="Invitation claim link"]')).toBeNull();
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
  expect(document.activeElement).toBe(button('regenerate'));
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.getElementById('ua-inv-lifecycle')).toBeNull(); expect(document.activeElement).toBe(opener);
});

it('requires explicit regeneration confirmation, bounds TTL and shows only its immediate manual link', async () => {
  open(userId, () => true); await tick();
  const ttl = document.querySelector<HTMLInputElement>('#ua-il-ttl')!;
  ttl.value = '169'; click('regenerate'); expect(post).not.toHaveBeenCalled(); expect(status()).toContain('whole-number');
  ttl.value = '48'; click('regenerate'); expect(post).not.toHaveBeenCalled();
  expect(document.querySelector('#ua-il-question')!.textContent).toContain('current link will stop working');
  const url = `https://console.example.test/auth/onboarding/invitation#token=private-${id}`;
  post.mockResolvedValue({ status: 200, body: { invitation: { ...metadata(), generation: 2 }, claim_url: url,
    delivery: { status: 'uncertain', state: 'unknown', providerMessage: 'private provider diagnostic' } } });
  click('apply'); click('apply'); await tick();
  expect(post).toHaveBeenCalledTimes(1); expect(post).toHaveBeenCalledWith(`/admin/accounts/invitations/${id}/regenerate`, { body: { ttl_hours: 48 } });
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Invitation claim link"]')!;
  expect(field.readOnly).toBe(true); expect(field.value).toBe(url); expect(document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, url.length]);
  expect(document.body.textContent).toContain('Unknown'); expect(document.body.textContent).not.toContain('private provider diagnostic');
  expect(document.body.textContent).toContain(metadata().expires_at);
  expect(dom.window.localStorage.length).toBe(0); expect(dom.window.sessionStorage.length).toBe(0);
  click('inspect'); await tick(); expect(document.querySelector('input[aria-label="Invitation claim link"]')).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});

it('confirms successful revocation separately from an uncertain outcome and never replays it', async () => {
  open(userId, () => true); await tick(); click('revoke'); click('back'); expect(post).not.toHaveBeenCalled();
  click('revoke'); post.mockResolvedValue(reply('revoked')); click('apply'); await tick();
  expect(status()).toContain('Invitation revoked.'); expect(button('regenerate').disabled).toBe(true);
  expect(post).toHaveBeenCalledWith(`/admin/accounts/invitations/${id}/revoke`, { body: {} });
  click('inspect'); await tick(); click('revoke'); post.mockRejectedValue(new Error('raw private database error')); click('apply'); await tick();
  expect(status()).toContain('outcome'); expect(status()).not.toContain('Invitation revoked.');
  expect(document.body.textContent).not.toContain('raw private'); expect(button('revoke').disabled).toBe(true);
  expect(post).toHaveBeenCalledTimes(2); click('inspect'); await tick(); expect(post).toHaveBeenCalledTimes(2);
});

it.each(['pagehide', 'elevation'])('blocks close while mutation is pending but force-clears on %s and ignores its late secret', async event => {
  open(userId, () => true); await tick(); click('regenerate');
  let finish!: (value: unknown) => void; post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  click('apply'); document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.getElementById('ua-inv-lifecycle')).not.toBeNull();
  dom.window.dispatchEvent(event === 'pagehide' ? new dom.window.PageTransitionEvent('pagehide') :
    new dom.window.CustomEvent('dh:elevation-changed', { detail: { active: false } }));
  expect(document.getElementById('ua-inv-lifecycle')).toBeNull();
  finish({ status: 200, body: { ...reply().body, claim_url: 'private-late-link' } }); await tick();
  expect(document.body.innerHTML).not.toContain('private-late-link'); expect(post).toHaveBeenCalledTimes(1);
});

it('keeps absent and denied lookup metadata unavailable and cannot mutate a mismatched account', async () => {
  for (const response of [{ status: 404 }, { status: 403 }, { status: 200, body: { invitation: { ...metadata(), user_id: randomUUID() } } }]) {
    get.mockResolvedValue(response); open(userId, () => true); await tick();
    expect(button('regenerate').disabled).toBe(true); expect(document.querySelector('#ua-il-details')!.textContent).toBe('');
    click('close');
  }
  expect(post).not.toHaveBeenCalled();
});
