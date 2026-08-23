import { describe, expect, it } from '@jest/globals';

import {
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from '../../../../src/web-console/modules/integrations/BoundedResponseReader.js';

describe('readBoundedResponseText', () => {
  it('rejects an oversized declared or streamed response', async () => {
    await expect(readBoundedResponseText(new Response('oversized', {
      headers: { 'content-length': '9' },
    }), 8)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);

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
