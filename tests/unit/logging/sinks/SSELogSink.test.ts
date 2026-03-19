import http from 'http';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { SSELogSink } from '../../../../src/logging/sinks/SSELogSink.js';
import { MemoryLogSink } from '../../../../src/logging/sinks/MemoryLogSink.js';
import type { UnifiedLogEntry } from '../../../../src/logging/types.js';

function makeEntry(overrides: Partial<UnifiedLogEntry> = {}): UnifiedLogEntry {
  return {
    id: 'LOG-1234-0',
    timestamp: '2026-02-10T15:30:00.000Z',
    category: 'application',
    level: 'info',
    source: 'TestSource',
    message: 'Test message',
    ...overrides,
  };
}

function createMemorySink(): MemoryLogSink {
  return new MemoryLogSink({
    appCapacity: 100,
    securityCapacity: 100,
    perfCapacity: 100,
    telemetryCapacity: 100,
  });
}

function httpGet(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sseConnect(url: string): { req: http.ClientRequest; chunks: string[]; close: () => void } {
  const chunks: string[] = [];
  const req = http.get(url, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => { chunks.push(chunk as string); });
  });
  return {
    req,
    chunks,
    close: () => { req.destroy(); },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SSELogSink', () => {
  let memorySink: MemoryLogSink;
  let sink: SSELogSink;
  let baseUrl: string;

  beforeEach(async () => {
    memorySink = createMemorySink();
    sink = new SSELogSink({ port: 0, memorySink });
    await sink.start();
    baseUrl = `http://127.0.0.1:${sink.getPort()}`;
  });

  afterEach(async () => {
    await sink.close();
  });

  // -----------------------------------------------------------------------
  // ILogSink contract
  // -----------------------------------------------------------------------

  describe('ILogSink contract', () => {
    test('write() does not throw with no clients connected', () => {
      expect(() => sink.write(makeEntry())).not.toThrow();
    });

    test('flush() resolves without error', async () => {
      await expect(sink.flush()).resolves.toBeUndefined();
    });

    test('close() shuts down the server', async () => {
      await sink.close();
      await expect(httpGet(baseUrl + '/health')).rejects.toThrow();
    });

    test('close() is safe to call multiple times', async () => {
      await sink.close();
      await expect(sink.close()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // HTTP endpoints
  // -----------------------------------------------------------------------

  describe('HTTP endpoints', () => {
    test('GET / returns 200 with text/html content type', async () => {
      const res = await httpGet(baseUrl + '/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    test('GET / contains expected title', async () => {
      const res = await httpGet(baseUrl + '/');
      expect(res.body).toContain('<title>DollhouseMCP Log Viewer</title>');
    });

    test('GET /health returns 200 with JSON status', async () => {
      const res = await httpGet(baseUrl + '/health');
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
    });

    test('GET /health includes clients count', async () => {
      const res = await httpGet(baseUrl + '/health');
      const json = JSON.parse(res.body);
      expect(typeof json.clients).toBe('number');
    });

    test('GET /logs returns 200 with entries array', async () => {
      memorySink.write(makeEntry());
      const res = await httpGet(baseUrl + '/logs');
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(Array.isArray(json.entries)).toBe(true);
      expect(json.entries).toHaveLength(1);
    });

    test('GET /logs?category=security filters results', async () => {
      memorySink.write(makeEntry({ category: 'application', id: 'A' }));
      memorySink.write(makeEntry({ category: 'security', id: 'S' }));
      const res = await httpGet(baseUrl + '/logs?category=security');
      const json = JSON.parse(res.body);
      expect(json.entries).toHaveLength(1);
      expect(json.entries[0].id).toBe('S');
    });

    test('GET /logs?level=warn filters by minimum level', async () => {
      memorySink.write(makeEntry({ level: 'info', id: 'I' }));
      memorySink.write(makeEntry({ level: 'warn', id: 'W' }));
      memorySink.write(makeEntry({ level: 'error', id: 'E' }));
      const res = await httpGet(baseUrl + '/logs?level=warn');
      const json = JSON.parse(res.body);
      expect(json.entries).toHaveLength(2);
      const ids = json.entries.map((e: UnifiedLogEntry) => e.id);
      expect(ids).toContain('W');
      expect(ids).toContain('E');
    });

    test('GET /logs?limit=5 paginates correctly', async () => {
      for (let i = 0; i < 10; i++) {
        memorySink.write(makeEntry({ id: `LOG-${i}` }));
      }
      const res = await httpGet(baseUrl + '/logs?limit=5');
      const json = JSON.parse(res.body);
      expect(json.entries).toHaveLength(5);
      expect(json.hasMore).toBe(true);
      expect(json.total).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // SSE streaming
  // -----------------------------------------------------------------------

  describe('SSE streaming', () => {
    test('GET /logs/stream returns 200 with text/event-stream', async () => {
      const client = sseConnect(baseUrl + '/logs/stream');
      await wait(50);
      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).toContain(':connected');
    });

    test('writing an entry broadcasts to connected client', async () => {
      const client = sseConnect(baseUrl + '/logs/stream');
      await wait(50);

      sink.write(makeEntry({ message: 'broadcast-test' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).toContain('broadcast-test');
    });

    test('?category=security only receives security entries', async () => {
      const client = sseConnect(baseUrl + '/logs/stream?category=security');
      await wait(50);

      sink.write(makeEntry({ category: 'application', message: 'app-msg' }));
      sink.write(makeEntry({ category: 'security', message: 'sec-msg' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).not.toContain('app-msg');
      expect(joined).toContain('sec-msg');
    });

    test('?level=warn only receives warn+ entries', async () => {
      const client = sseConnect(baseUrl + '/logs/stream?level=warn');
      await wait(50);

      sink.write(makeEntry({ level: 'info', message: 'info-msg' }));
      sink.write(makeEntry({ level: 'warn', message: 'warn-msg' }));
      sink.write(makeEntry({ level: 'error', message: 'error-msg' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).not.toContain('info-msg');
      expect(joined).toContain('warn-msg');
      expect(joined).toContain('error-msg');
    });

    test('?source=Persona filters by source substring', async () => {
      const client = sseConnect(baseUrl + '/logs/stream?source=Persona');
      await wait(50);

      sink.write(makeEntry({ source: 'PersonaManager', message: 'persona-msg' }));
      sink.write(makeEntry({ source: 'AgentManager', message: 'agent-msg' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).toContain('persona-msg');
      expect(joined).not.toContain('agent-msg');
    });

    test('multiple clients with different filters receive correctly', async () => {
      const clientA = sseConnect(baseUrl + '/logs/stream?category=security');
      const clientB = sseConnect(baseUrl + '/logs/stream?level=error');
      await wait(50);

      sink.write(makeEntry({ category: 'security', level: 'info', message: 'sec-info' }));
      sink.write(makeEntry({ category: 'application', level: 'error', message: 'app-error' }));
      await wait(50);

      clientA.close();
      clientB.close();
      await wait(50);

      const joinedA = clientA.chunks.join('');
      const joinedB = clientB.chunks.join('');

      // Client A: category=security — should get sec-info, not app-error
      expect(joinedA).toContain('sec-info');
      expect(joinedA).not.toContain('app-error');

      // Client B: level=error — should get app-error, not sec-info
      expect(joinedB).toContain('app-error');
      expect(joinedB).not.toContain('sec-info');
    });
  });

  // -----------------------------------------------------------------------
  // Client lifecycle
  // -----------------------------------------------------------------------

  describe('client lifecycle', () => {
    test('clientCount increments on connect, decrements on disconnect', async () => {
      expect(sink.clientCount).toBe(0);

      const client = sseConnect(baseUrl + '/logs/stream');
      await wait(50);
      expect(sink.clientCount).toBe(1);

      client.close();
      await wait(50);
      expect(sink.clientCount).toBe(0);
    });

    test('close() terminates all client connections', async () => {
      sseConnect(baseUrl + '/logs/stream');
      sseConnect(baseUrl + '/logs/stream');
      await wait(50);
      expect(sink.clientCount).toBe(2);

      await sink.close();
      expect(sink.clientCount).toBe(0);
    });

    test('server binds to 127.0.0.1 (localhost only)', () => {
      const addr = (sink as unknown as { server: http.Server }).server.address();
      expect(addr).not.toBeNull();
      if (typeof addr === 'object' && addr !== null) {
        expect(addr.address).toBe('127.0.0.1');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Filter matching
  // -----------------------------------------------------------------------

  describe('filter matching', () => {
    test('no filter matches all entries', async () => {
      const client = sseConnect(baseUrl + '/logs/stream');
      await wait(50);

      sink.write(makeEntry({ category: 'application', level: 'debug', message: 'a' }));
      sink.write(makeEntry({ category: 'security', level: 'error', message: 'b' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).toContain('"message":"a"');
      expect(joined).toContain('"message":"b"');
    });

    test('category filter rejects non-matching', async () => {
      const client = sseConnect(baseUrl + '/logs/stream?category=performance');
      await wait(50);

      sink.write(makeEntry({ category: 'application', message: 'nope' }));
      sink.write(makeEntry({ category: 'performance', message: 'yes' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).not.toContain('nope');
      expect(joined).toContain('yes');
    });

    test('level filter uses priority comparison', async () => {
      const client = sseConnect(baseUrl + '/logs/stream?level=info');
      await wait(50);

      sink.write(makeEntry({ level: 'debug', message: 'low' }));
      sink.write(makeEntry({ level: 'info', message: 'mid' }));
      sink.write(makeEntry({ level: 'error', message: 'high' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).not.toContain('low');
      expect(joined).toContain('mid');
      expect(joined).toContain('high');
    });

    test('multiple filters are conjunctive (AND)', async () => {
      const client = sseConnect(baseUrl + '/logs/stream?category=security&level=error');
      await wait(50);

      sink.write(makeEntry({ category: 'security', level: 'info', message: 'sec-low' }));
      sink.write(makeEntry({ category: 'application', level: 'error', message: 'app-high' }));
      sink.write(makeEntry({ category: 'security', level: 'error', message: 'sec-high' }));
      await wait(50);

      client.close();
      await wait(50);

      const joined = client.chunks.join('');
      expect(joined).not.toContain('sec-low');
      expect(joined).not.toContain('app-high');
      expect(joined).toContain('sec-high');
    });
  });
});
