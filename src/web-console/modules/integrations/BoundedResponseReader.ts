export class ResponseBodyTooLargeError extends Error {
  constructor() {
    super('response body exceeds configured limit');
    this.name = 'ResponseBodyTooLargeError';
  }
}

/** Consume an HTTP response without allowing a missing or false length header to bypass the cap. */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseBodyTooLargeError();
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ResponseBodyTooLargeError();
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}
