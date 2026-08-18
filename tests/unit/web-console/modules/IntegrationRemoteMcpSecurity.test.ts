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

  it('redacts credentials in already-serialized JSON and log strings', () => {
    const result = redactRemoteMcpCredentialEchoes({
      shortEscape: 'abc\\/def',
      unicodeEscape: '\\u0061bc\\u002fdef',
      mixed: 'a%62c\\u002Fdef',
      ordinaryCaseIsSignificant: '\\u0041bc\\/def',
    }, 'abc/def');

    expect(result).toEqual({
      shortEscape: '[redacted]',
      unicodeEscape: '[redacted]',
      mixed: '[redacted]',
      ordinaryCaseIsSignificant: '\\u0041bc\\/def',
    });
  });

  it('redacts credentials recovered through bounded recursive decoding', () => {
    const result = redactRemoteMcpCredentialEchoes({
      doublePercent: 'abc%252Fdef',
      nestedJson: 'abc\\\\/def',
      mixedLayers: 'abc%255Cu002fdef',
      malformedNeighbor: '%ZZabc%252Fdef',
      invalidUtf8Neighbor: '%FF%61%62%63%252F%64%65%66',
    }, 'abc/def');

    expect(result).toEqual({
      doublePercent: '[redacted]',
      nestedJson: '[redacted]',
      mixedLayers: '[redacted]',
      malformedNeighbor: '[redacted]',
      invalidUtf8Neighbor: '[redacted]',
    });
  });

  it('redacts credential substrings in serialized primitives', () => {
    expect(redactRemoteMcpCredentialEchoes({ value: 91234 }, '123')).toEqual({
      value: '9[redacted]4',
    });
    expect(redactRemoteMcpCredentialEchoes({ value: true }, 'rue')).toEqual({
      value: 't[redacted]',
    });
    expect(redactRemoteMcpCredentialEchoes({ value: 'd]xx' }, 'd]x')).toEqual({
      value: '[redacted]',
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

  it('caps each GET SSE event without imposing a cumulative stream limit', async () => {
    const encoder = new TextEncoder();
    const allowedFetch = jest.fn<PinnedFetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('1234\n'));
        controller.enqueue(encoder.encode('\n5678\r\n'));
        controller.enqueue(encoder.encode('\r\n'));
        controller.close();
      },
    })));
    const oversizedFetch = jest.fn<PinnedFetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('1234'));
        controller.enqueue(encoder.encode('56789'));
        controller.close();
      },
    })));

    const response = await createBoundedRemoteMcpFetch(allowedFetch, 8)(new URL('https://mcp.example.com'), {
      method: 'GET',
    });
    const oversized = await createBoundedRemoteMcpFetch(oversizedFetch, 8)(new URL('https://mcp.example.com'), {
      method: 'GET',
    });

    await expect(response.text()).resolves.toBe('1234\n\n5678\r\n\r\n');
    await expect(oversized.text()).rejects.toBeInstanceOf(RemoteMcpPayloadSafetyError);
  });

  it('fails closed for empty credentials and circular custom-client output', () => {
    expect(() => redactRemoteMcpCredentialEchoes({}, '')).toThrow(RemoteMcpPayloadSafetyError);
    expect(() => redactRemoteMcpCredentialEchoes({}, '[redacted]')).toThrow(RemoteMcpPayloadSafetyError);
    expect(() => redactRemoteMcpCredentialEchoes({}, 'red')).toThrow(RemoteMcpPayloadSafetyError);
    expect(() => redactRemoteMcpCredentialEchoes({}, '\uD800')).toThrow(RemoteMcpPayloadSafetyError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => redactRemoteMcpCredentialEchoes(circular, 'credential')).toThrow(
      RemoteMcpPayloadSafetyError,
    );
  });
});
