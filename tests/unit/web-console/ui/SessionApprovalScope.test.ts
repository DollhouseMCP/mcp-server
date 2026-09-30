import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';

const get = jest.fn<(...args: any[]) => Promise<any>>();
const post = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../../../src/web-console/ui/api', () => ({ get, post, del: jest.fn() }));
jest.unstable_mockModule('../../../../src/web-console/ui/polling', () => ({
  createVisiblePoller: () => ({ start: jest.fn(), stop: jest.fn() }), isAbortError: () => false,
}));
const { createSessionDetail } = await import('../../../../src/web-console/ui/session-detail');
let dom: JSDOM;
let detail: { destroy(): void } | undefined;
afterEach(() => {
  detail?.destroy();
  dom?.window.close();
  jest.clearAllMocks();
});

describe('session approval scope UI', () => {
  it.each([
    ['input_session', 'Approve exact request for session', 'Approve this exact request for the rest of this session?'],
    ['session', 'Approve tool for session', 'Approve this tool for the rest of this session?'],
  ])('uses accurate wording and submits %s', async (scope, label, prompt) => {
    dom = new JSDOM('<main></main>');
    const host = dom.window.document.querySelector('main')!;
    get.mockImplementation(async url => ({ status: 200, body: url.endsWith('/approvals')
      ? { approvals: [{ approval_id: 'approval', status: 'pending', tool_name: 'Tool', allowed_scopes: ['once', scope] }] }
      : { session_id: 'session', created_at: new Date().toISOString() } }));
    post.mockResolvedValue({ status: 200 });
    const confirm = jest.fn<(...args: any[]) => Promise<boolean>>().mockResolvedValue(true);
    detail = await createSessionDetail(host, 'session', {
      hasRoute: (_method: string, route: string) => route.includes('/approvals'), confirm, toast: jest.fn(),
    });
    const button = host.querySelector<HTMLButtonElement>(`[data-approval-scope="${scope}"]`);
    expect(button?.textContent).toBe(label);
    expect(host.querySelector(`[data-approval-scope="${scope === 'session' ? 'input_session' : 'session'}"]`)).toBeNull();
    button!.click();
    await new Promise(resolve => setImmediate(resolve));
    expect(confirm).toHaveBeenCalledWith(prompt, 'Approve for session');
    expect(post).toHaveBeenCalledWith('/me/sessions/session/approvals/approval/approve', expect.objectContaining({ body: { scope } }));
  });
});
