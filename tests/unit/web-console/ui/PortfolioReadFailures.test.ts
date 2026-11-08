/* global document */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';

const get = jest.fn<(...args: any[]) => Promise<any>>();
let refresh: () => Promise<void>;
jest.unstable_mockModule('../../../../src/web-console/ui/api', () => ({ get, post: jest.fn() }));
jest.unstable_mockModule('../../../../src/web-console/ui/portfolio-authoring', () => ({
  createPortfolioAuthoring: (options: { refresh: () => Promise<void> }) => {
    refresh = options.refresh;
    return { capabilities: {} };
  },
}));

let dom: JSDOM;
let portfolio: typeof import('../../../../src/web-console/ui/portfolio');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><body><main></main></body>');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  portfolio = await import('../../../../src/web-console/ui/portfolio');
});

afterAll(() => {
  dom.window.close();
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});

describe('portfolio read failure display', () => {
  it('shows escaped failure evidence alongside survivors and clears it after a healthy refresh', async () => {
    const elements = [{ name: 'Healthy', type: 'skills', tags: [], updated_at: '2026-01-01T00:00:00Z' }];
    get.mockResolvedValue({ status: 200, body: { elements, complete: false,
      failures: [{ reference: '<img src=x>.md', reason: 'Definition could not be read' }] } });
    const panel = document.querySelector('main')!;
    await portfolio.init(panel, { hasRoute: () => false });
    const notice = panel.querySelector<HTMLElement>('#pf-read-failures');
    expect(notice).not.toBeNull();
    expect(notice!.hidden).toBe(false);
    expect(notice!.textContent).toContain('<img src=x>.md');
    expect(notice!.textContent).toContain('Definition could not be read');
    expect(notice!.querySelector('img')).toBeNull();
    expect(panel.querySelector('#pf-grid')!.textContent).toContain('Healthy');
    get.mockResolvedValue({ status: 200, body: { elements, complete: true, failures: [] } });
    await refresh();
    expect(notice!.hidden).toBe(true);
    expect(notice!.textContent).toBe('');
  });
});
