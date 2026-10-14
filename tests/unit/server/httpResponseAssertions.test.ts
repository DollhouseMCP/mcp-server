import { describe, expect, it, jest } from '@jest/globals';
import { assertSseResponse, readHttpResponse } from '../../helpers/httpResponseAssertions.js';

describe('HTTP response diagnostics', () => {
  it('rejects and cancels an unexpected live SSE without waiting for its body', async () => {
    const cancel = jest.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } });
    await expect(readHttpResponse(response, 404, 'Refused GET')).rejects.toThrow('received HTTP 200; body=<unexpected SSE cancelled>');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('leaves accepted GET streams unread but reads finite POST SSE results', async () => {
    const response = new Response('event: message\ndata: result\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await assertSseResponse(response);
    expect(response.bodyUsed).toBe(false);
    expect(await readHttpResponse(response, 200, 'POST', true)).toContain('result');
  });

  it('preserves status and body for finite failures', async () => {
    await expect(readHttpResponse(new Response('unavailable', { status: 503 }), 200, 'POST')).rejects.toThrow('received HTTP 503; body="unavailable"');
  });
});
