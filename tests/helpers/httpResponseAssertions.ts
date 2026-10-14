/** Preserve HTTP status and body together when a transport assertion fails. */
export async function readHttpResponse(
  response: Response,
  expectedStatus: number | readonly number[],
  context: string,
  requireBody = false,
): Promise<string> {
  const statuses = typeof expectedStatus === 'number' ? [expectedStatus] : expectedStatus;
  if (!statuses.includes(response.status) && response.headers.get('content-type')?.includes('text/event-stream')) {
    // A wrongly admitted GET can stay open forever. Cancel without awaiting peer cleanup.
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`${context}: expected HTTP ${statuses.join('/')}; received HTTP ${response.status}; body=<unexpected SSE cancelled>`);
  }
  const body = await response.text();
  if (!statuses.includes(response.status) || (requireBody && response.status === 200 && body.length === 0)) {
    throw new Error(`${context}: expected HTTP ${statuses.join('/')} ${requireBody ? 'with a response body' : ''}; received HTTP ${response.status}; body=${JSON.stringify(body.slice(0, 4000))}`);
  }
  return body;
}

/** Successful SSE stays open; only consume the body on unexpected status. */
export async function assertSseResponse(response: Response): Promise<void> {
  if (response.status !== 200) await readHttpResponse(response, 200, 'SSE GET');
}
