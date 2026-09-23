/* global document */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';

const get = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../../../src/web-console/ui/api', () => ({ get }));

let dom: JSDOM;
let connect: typeof import('../../../../src/web-console/ui/connect');
let fetchMock: jest.Mock;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><body><main id="panel"></main><button class="console-tab" data-tab="sessions"></button></body>', {
    url: 'https://mcp.example.test/ui/', pretendToBeVisual: true,
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    location: { configurable: true, value: dom.window.location },
  });
  connect = await import('../../../../src/web-console/ui/connect');
});

beforeEach(() => {
  document.body.innerHTML = '<main id="panel"></main><button class="console-tab" data-tab="sessions"></button>';
  get.mockReset();
  get.mockResolvedValue({ status: 200, body: { sessions: [] } });
  fetchMock = jest.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ resource: 'https://mcp.example.test/mcp' }),
  }));
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn(() => Promise.resolve()) } });
});

afterAll(() => {
  dom.window.close();
  for (const key of ['document', 'navigator', 'location', 'fetch']) Reflect.deleteProperty(globalThis, key);
});

describe('hosted connection endpoint validation', () => {
  it('accepts only the same-origin canonical MCP resource', () => {
    expect(connect.validateHostedMcpEndpoint('https://mcp.example.test/mcp', 'https://mcp.example.test')).toBe('https://mcp.example.test/mcp');
    expect(connect.validateHostedMcpEndpoint('http://localhost:3000/mcp', 'http://localhost:3000')).toBe('http://localhost:3000/mcp');
  });

  it.each([
    'http://mcp.example.test/mcp',
    'https://other.example.test/mcp',
    'https://user:secret@mcp.example.test/mcp',
    'https://mcp.example.test/mcp?token=secret',
    'https://mcp.example.test/mcp#secret',
  ])('rejects unsafe endpoint %s', endpoint => {
    expect(() => connect.validateHostedMcpEndpoint(endpoint, 'https://mcp.example.test')).toThrow('safe endpoint');
  });

  it('rejects a same-origin hostname containing a shell quote', () => {
    expect(() => connect.validateHostedMcpEndpoint("https://a'b.example/mcp", "https://a'b.example"))
      .toThrow('safe endpoint');
    expect(() => connect.validateHostedMcpEndpoint('https://a%27b.example/mcp', 'https://a%27b.example'))
      .toThrow('safe endpoint');
    expect(() => connect.validateHostedMcpEndpoint('https://a＇b.example/mcp', 'https://a＇b.example'))
      .toThrow('safe endpoint');
  });

  it('generates distinct hosted commands and a Cursor base64 JSON link', () => {
    const artifacts = connect.connectionArtifacts('https://mcp.example.test/mcp', 'https://mcp.example.test');
    expect(artifacts.claudeAdd).toBe("claude mcp add --transport http --scope user dollhouse-beta 'https://mcp.example.test/mcp'");
    expect(artifacts.codexLogin).toBe('codex mcp login dollhouse-beta');
    const link = new URL(artifacts.cursorLink);
    expect(link.protocol).toBe('cursor:');
    expect(link.searchParams.get('name')).toBe('dollhouse-beta');
    expect(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString('utf8'))).toEqual({ url: artifacts.endpoint });
    expect(JSON.parse(artifacts.cursorConfig)).toEqual({ mcpServers: { 'dollhouse-beta': { url: artifacts.endpoint } } });
  });

  it('generates artifacts for an authoritative custom MCP path', () => {
    const artifacts = connect.connectionArtifacts('https://mcp.example.test/remote-mcp', 'https://mcp.example.test');
    expect(artifacts.endpoint).toBe('https://mcp.example.test/remote-mcp');
    expect(artifacts.claudeAdd).toContain("'https://mcp.example.test/remote-mcp'");
    expect(JSON.parse(artifacts.cursorConfig)).toEqual({
      mcpServers: { 'dollhouse-beta': { url: 'https://mcp.example.test/remote-mcp' } },
    });
  });

  it('keeps artifact generation bound to the page origin', () => {
    expect(() => connect.connectionArtifacts('https://evil.example/mcp', 'https://mcp.example.test'))
      .toThrow('safe endpoint');
  });
});

describe('hosted connection UI', () => {
  it('renders honest empty and connected states from the current-user session API', async () => {
    const panel = document.querySelector<HTMLElement>('#panel')!;
    await connect.init(panel, { toast: jest.fn() });
    expect(fetchMock).toHaveBeenCalledWith('/.well-known/oauth-protected-resource', {
      headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error',
    });
    expect(panel.textContent).toContain('No connected apps yet.');
    expect(panel.textContent).not.toContain('Connected successfully');

    get.mockResolvedValueOnce({ status: 200, body: { sessions: [{ client_info: { name: '<Claude>', version: '1.2' }, last_active_at: new Date().toISOString() }] } });
    (panel.querySelector('#connect-refresh') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel.textContent).toContain('1 connected app');
    expect(panel.textContent).toContain('<Claude> 1.2');
    expect(panel.textContent).toContain('last active');
    expect(panel.querySelector('.connect-state img')).toBeNull();
  });

  it('fails closed for bad discovery metadata and shows session API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ resource: 'https://evil.example/mcp' }) });
    get.mockResolvedValueOnce({ status: 503, body: {} });
    const panel = document.querySelector<HTMLElement>('#panel')!;
    await connect.init(panel, { toast: jest.fn() });
    expect(panel.textContent).toContain('Connection setup is unavailable.');
    expect(panel.textContent).toContain('Could not check connected apps.');
    expect(panel.querySelector('[href^="cursor:"]')).toBeNull();
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-client]')) button.click();
    expect(panel.textContent).toContain('Setup instructions will appear when endpoint discovery is available.');
    expect(panel.querySelector('[href^="cursor:"]')).toBeNull();
  });

  it('reports clipboard failure and selects a manual fallback without claiming connection', async () => {
    const toast = jest.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn(() => Promise.reject(new Error('denied'))) } });
    const panel = document.querySelector<HTMLElement>('#panel')!;
    await connect.init(panel, { toast });
    (panel.querySelector('.connect-client-panel button') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(toast).toHaveBeenCalledWith('Copy failed. The text is selected so you can copy it manually.', 'warn');
    expect(panel.querySelector<HTMLTextAreaElement>('.connect-copy-fallback')?.selectionEnd).toBeGreaterThan(0);
    expect(panel.textContent).not.toContain('connected successfully');
  });

  it('omits the Sessions link when the combined Sessions surface is unavailable', async () => {
    const panel = document.querySelector<HTMLElement>('#panel')!;
    await connect.init(panel, {
      toast: jest.fn(),
      hasRoute: (_method: string, path: string) => path === '/me/sessions',
    });
    expect(panel.querySelector('#connect-open-sessions')).toBeNull();
  });

  it('opens Sessions when both required routes are available', async () => {
    const sessionsTab = document.querySelector<HTMLButtonElement>('[data-tab="sessions"]')!;
    const clicked = jest.fn();
    sessionsTab.addEventListener('click', clicked);
    const panel = document.querySelector<HTMLElement>('#panel')!;
    await connect.init(panel, { toast: jest.fn(), hasRoute: () => true });
    panel.querySelector<HTMLButtonElement>('#connect-open-sessions')!.click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
