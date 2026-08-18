import { describe, expect, it, jest } from '@jest/globals';

import {
  createBoundedRemoteMcpFetch,
  redactRemoteMcpCredentialEchoes,
  RemoteMcpPayloadSafetyError,
} from '../../../../src/web-console/modules/integrations/IntegrationRemoteMcpSecurity.js';
import type { PinnedFetch } from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

describe('IntegrationRemoteMcpSecurity', () => {
  it('redacts equivalent lowercase and mixed-case percent escapes', () => {
    const result = redactRemoteMcpCredentialEchoes({
      lower: 'abc%2fdef%3ahere',
      mixed: 'abc%2Fdef%3ahere',
      ordinaryCaseIsSignificant: 'ABC%2fdef%3ahere',
    }, 'abc/def:here');

    expect(result).toEqual({
      lower: '[redacted]',
      mixed: '[redacted]',
      ordinaryCaseIsSignificant: 'ABC%2fdef%3ahere',
    });
  });

  it('redacts URI-unreserved credential characters when remotely percent encoded', () => {
    const credential = 'header.payload-signature_v1~';
    const result = redactRemoteMcpCredentialEchoes({
      encoded: 'header%2epayload%2Dsignature%5fv1%7e',
      mixed: 'header%2Epayload-signature%5Fv1~',
      ordinaryCaseIsSignificant: 'Header%2epayload%2Dsignature%5fv1%7e',
    }, credential);

    expect(result).toEqual({
      encoded: '[redacted]',
      mixed: '[redacted]',
      ordinaryCaseIsSignificant: 'Header%2epayload%2Dsignature%5fv1%7e',
    });
  });

  it('rejects declared and chunked POST responses above the byte limit', async () => {
    const encoder = new TextEncoder();
    const declaredFetch = jest.fn<PinnedFetch>().mockResolvedValue(new Response('small', {
      headers: { 'content-length': '9' },
    }));
    const chunkedFetch = jest.fn<PinnedFetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('12345'));
        controller.enqueue(encoder.encode('67890'));
        controller.close();
      },
    })));

    await expect(createBoundedRemoteMcpFetch(declaredFetch, 8)(new URL('https://mcp.example.com'), {
      method: 'POST',
    })).rejects.toBeInstanceOf(RemoteMcpPayloadSafetyError);
    const chunked = await createBoundedRemoteMcpFetch(chunkedFetch, 8)(new URL('https://mcp.example.com'), {
      method: 'POST',
    });
    await expect(chunked.text()).rejects.toBeInstanceOf(RemoteMcpPayloadSafetyError);
  });

  it('leaves long-lived GET response streams uncapped', async () => {
    const pinnedFetch = jest.fn<PinnedFetch>().mockResolvedValue(new Response('1234567890'));

    const response = await createBoundedRemoteMcpFetch(pinnedFetch, 8)(new URL('https://mcp.example.com'), {
      method: 'GET',
    });

    await expect(response.text()).resolves.toBe('1234567890');
  });

  it('fails closed for empty credentials and circular custom-client output', () => {
    expect(() => redactRemoteMcpCredentialEchoes({}, '')).toThrow(RemoteMcpPayloadSafetyError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => redactRemoteMcpCredentialEchoes(circular, 'credential')).toThrow(
      RemoteMcpPayloadSafetyError,
    );
  });
});
