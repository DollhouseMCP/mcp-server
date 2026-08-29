import { describe, expect, it, jest } from '@jest/globals';

import {
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from '../../../../src/web-console/modules/integrations/BoundedResponseReader.js';

describe('readBoundedResponseText', () => {
  it('rejects an oversized declared or streamed response', async () => {
    const declaredOversized = new Response('oversized', {
      headers: { 'content-length': '9' },
    });
    const body = declaredOversized.body;
    if (!body) throw new Error('test response body missing');
    const cancel = jest.spyOn(body, 'cancel');

    await expect(readBoundedResponseText(declaredOversized, 8))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(cancel).toHaveBeenCalledTimes(1);

    await expect(readBoundedResponseText(new Response('oversized', {
      headers: { 'content-length': 'invalid' },
    }), 8)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it('measures UTF-8 bytes rather than JavaScript code units', async () => {
    await expect(readBoundedResponseText(new Response('é'), 1))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    await expect(readBoundedResponseText(new Response('é'), 2)).resolves.toBe('é');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects invalid maxBytes value %s',
    async maxBytes => {
      await expect(readBoundedResponseText(new Response('ok'), maxBytes)).rejects.toBeInstanceOf(RangeError);
    },
  );
});
