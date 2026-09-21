/* global document */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';

const get = jest.fn<(...args: any[]) => Promise<any>>();
const post = jest.fn<(...args: any[]) => Promise<any>>();
const del = jest.fn<(...args: any[]) => Promise<any>>();
const patch = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../../../src/web-console/ui/api', () => ({ get, post, del, patch }));

let init: (panel: HTMLElement, context: Record<string, unknown>) => Promise<void>;
let dom: JSDOM;
let toast: ReturnType<typeof jest.fn>;

function nextTurn(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function apiResponse(status: number, body: unknown): Record<string, unknown> {
  return { status, body };
}

async function mount(hasRoute: (method: string, path: string) => boolean): Promise<HTMLElement> {
  const panel = document.createElement('section');
  document.body.appendChild(panel);
  await init(panel, {
    toast,
    hasRoute,
    roleCatalog: { roles: [], grants: {} },
  });
  return panel;
}

function fillInvitation(modal: Element): void {
  (modal.querySelector('#ua-inv-display-name') as HTMLInputElement).value = 'Ada Lovelace';
  (modal.querySelector('#ua-inv-username') as HTMLInputElement).value = 'ada-lovelace';
  (modal.querySelector('#ua-inv-email') as HTMLInputElement).value = 'ada@example.test';
}

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://console.example.test/',
    pretendToBeVisual: true,
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    CSS: { configurable: true, value: { escape: (value: string) => value } }, // Fixtures use selector-safe UUIDs.
    navigator: { configurable: true, value: dom.window.navigator },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    CustomEvent: { configurable: true, value: dom.window.CustomEvent },
    addEventListener: { configurable: true, value: dom.window.addEventListener.bind(dom.window) },
    removeEventListener: { configurable: true, value: dom.window.removeEventListener.bind(dom.window) },
    dispatchEvent: { configurable: true, value: dom.window.dispatchEvent.bind(dom.window) },
  });
  ({ init } = await import('../../../../src/web-console/ui/users-admin'));
});

beforeEach(() => {
  document.body.replaceChildren();
  toast = jest.fn();
  get.mockReset();
  post.mockReset();
  del.mockReset();
  get.mockImplementation(async path => path === '/auth/me'
    ? apiResponse(200, { available_admin_capabilities: ['console:admin:accounts'] })
    : apiResponse(200, { items: [] }));
});

afterEach(() => {
  globalThis.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
});

afterAll(() => {
  dom.window.close();
  for (const key of [
    'document', 'navigator', 'HTMLElement', 'CustomEvent', 'CSS',
    'addEventListener', 'removeEventListener', 'dispatchEvent',
  ]) Reflect.deleteProperty(globalThis, key);
});

describe('users admin durable invitation dialog', () => {
  it('uses the durable route, TTL contract, fixed status, and ephemeral claim link', async () => {
    const panel = await mount((method, path) =>
      method === 'POST' && path === '/admin/accounts/invitations');
    const opener = panel.querySelector('#ua-invite') as HTMLButtonElement;
    opener.focus();
    opener.click();

    const modal = document.querySelector('#ua-invite-modal') as HTMLElement;
    const ttl = modal.querySelector('#ua-inv-ttl') as HTMLInputElement;
    expect(document.activeElement).toBe(modal.querySelector('#ua-inv-display-name'));
    expect([ttl.min, ttl.value, ttl.max]).toEqual(['1', '24', '168']);
    fillInvitation(modal);
    const claimUrl = 'https://console.example.test/claim?value=%3Cscript%3E';
    post.mockResolvedValue(apiResponse(201, {
      claim_url: claimUrl,
      invitation: { expires_at: '2099-09-21T12:00:00.000Z' },
      delivery: { status: 'recorded', state: 'submitted' },
    }));

    (modal.querySelector('#ua-inv-send') as HTMLButtonElement).click();
    await nextTurn();

    expect(post).toHaveBeenCalledWith('/admin/accounts/invitations', {
      body: {
        display_name: 'Ada Lovelace',
        username: 'ada-lovelace',
        email: 'ada@example.test',
        intended_roles: [],
        ttl_hours: 24,
      },
    });
    expect(modal.querySelector('#ua-inv-result')?.textContent).toContain('Submitted');
    expect(modal.querySelector('time')?.dateTime).toBe('2099-09-21T12:00:00.000Z');
    expect(modal.querySelector('#ua-inv-result')?.textContent).toContain('remaining');
    const copy = modal.querySelector('#ua-inv-copy') as HTMLInputElement;
    expect(copy.value).toBe(claimUrl);
    expect(document.activeElement).toBe(copy);
    expect([copy.selectionStart, copy.selectionEnd]).toEqual([0, claimUrl.length]);
    expect(modal.querySelector('script')).toBeNull();
    expect(dom.window.localStorage).toHaveLength(0);
    expect(dom.window.sessionStorage).toHaveLength(0);

    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('#ua-invite-modal')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('locks a committed invitation whose claim link is missing and directs regeneration', async () => {
    const panel = await mount((method, path) =>
      method === 'POST' && path === '/admin/accounts/invitations');
    (panel.querySelector('#ua-invite') as HTMLButtonElement).click();
    const modal = document.querySelector('#ua-invite-modal') as HTMLElement;
    fillInvitation(modal);
    post.mockResolvedValue(apiResponse(201, {
      invitation: { expires_at: '2099-09-21T12:00:00.000Z' },
      delivery: { status: 'unavailable', state: 'unknown' },
    }));

    (modal.querySelector('#ua-inv-send') as HTMLButtonElement).click();
    await nextTurn();

    expect((modal.querySelector('#ua-inv-send') as HTMLButtonElement).disabled).toBe(true);
    expect((modal.querySelector('#ua-inv-email') as HTMLInputElement).disabled).toBe(true);
    expect(modal.querySelector('#ua-inv-result')?.textContent).toContain('Regenerate the invitation');
    expect(document.activeElement).toBe(modal.querySelector('#ua-inv-result'));
    expect(toast).not.toHaveBeenCalledWith('Invite created.', 'success');
  });

  it('preserves the legacy route and payload when the durable route is absent', async () => {
    const panel = await mount((method, path) =>
      method === 'POST' && path === '/admin/accounts/users/invite');
    (panel.querySelector('#ua-invite') as HTMLButtonElement).click();
    const modal = document.querySelector('#ua-invite-modal') as HTMLElement;
    expect(modal.querySelector('#ua-inv-ttl')).toBeNull();
    fillInvitation(modal);
    post.mockResolvedValue(apiResponse(201, {
      invite_url: 'https://console.example.test/legacy-claim',
      expires_at: '2026-09-21T12:00:00.000Z',
    }));

    (modal.querySelector('#ua-inv-send') as HTMLButtonElement).click();
    await nextTurn();

    expect(post).toHaveBeenCalledWith('/admin/accounts/users/invite', {
      body: {
        display_name: 'Ada Lovelace',
        username: 'ada-lovelace',
        email: 'ada@example.test',
      },
    });
  });

  it.each(['elevation loss', 'pagehide'])('removes the claim surface and ignores a late response after %s', async lifecycleEvent => {
    const panel = await mount((method, path) =>
      method === 'POST' && path === '/admin/accounts/invitations');
    (panel.querySelector('#ua-invite') as HTMLButtonElement).click();
    const modal = document.querySelector('#ua-invite-modal') as HTMLElement;
    fillInvitation(modal);
    let finishRequest: ((value: unknown) => void) | undefined;
    post.mockImplementation(() => new Promise(resolve => { finishRequest = resolve; }));

    (modal.querySelector('#ua-inv-send') as HTMLButtonElement).click();
    await Promise.resolve();
    expect((modal.querySelector('#ua-inv-cancel') as HTMLButtonElement).disabled).toBe(true);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    (modal.querySelector('.confirm-backdrop') as HTMLElement).click();
    expect(document.querySelector('#ua-invite-modal')).toBe(modal);
    if (lifecycleEvent === 'elevation loss') {
      globalThis.dispatchEvent(new dom.window.CustomEvent('dh:elevation-changed', { detail: { active: false } }));
    } else globalThis.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
    expect(document.querySelector('#ua-invite-modal')).toBeNull();

    finishRequest?.(apiResponse(201, {
      claim_url: 'https://console.example.test/late-secret',
      delivery: { status: 'recorded', state: 'submitted' },
    }));
    await nextTurn();

    expect(document.body.textContent).not.toContain('late-secret');
    expect(toast).not.toHaveBeenCalledWith('Invite created.', 'success');
  });
});

it('opens management from the selected account only when lookup is advertised', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  get.mockImplementation(async path => {
    if (path === '/auth/me') return apiResponse(200, { available_admin_capabilities: ['console:admin:accounts'] });
    if (path.endsWith('/invitation')) return apiResponse(404, {});
    return apiResponse(200, { items: [{ user_id: userId, username: 'selected-user', roles: [], auth_methods: [] }] });
  });
  const panel = await mount((method, path) => method === 'GET' && path === '/admin/accounts/users/:user_id/invitation');
  (panel.querySelector('[data-user-row]') as HTMLElement).click();
  (panel.querySelector('#ua-manage-invitation') as HTMLButtonElement).click(); await nextTurn();
  expect(get).toHaveBeenCalledWith(`/admin/accounts/users/${userId}/invitation`);
  expect(document.querySelector('#ua-il-status')?.textContent).toContain('No durable invitation');
  globalThis.dispatchEvent(new dom.window.CustomEvent('dh:elevation-changed', { detail: { active: false } }));
  expect(document.getElementById('ua-inv-lifecycle')).toBeNull();
  const legacy = await mount(() => false);
  (legacy.querySelector('[data-user-row]') as HTMLElement).click();
  expect(legacy.querySelector('#ua-manage-invitation')).toBeNull();
});
