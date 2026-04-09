/**
 * Tests for ghost session cleanup (#1870).
 *
 * Covers: orphan auto-registration from log ingestion, session revival,
 * kill endpoint for PID=0 orphans, GET /api/sessions filtering,
 * concurrent ingestion, and session lifecycle after dismiss.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  createIngestRoutes,
  type IngestRoutesResult,
  type SessionInfo,
} from '../../../../src/web/console/IngestRoutes.js';

function buildApp(result: IngestRoutesResult) {
  const app = express();
  app.use(express.json());
  app.use(result.router);
  return app;
}

function makeEntry(msg = 'test') {
  return { message: msg, level: 'info', category: 'app', source: 'test', timestamp: new Date().toISOString() };
}

describe('Ghost session cleanup (#1870)', () => {
  let ir: IngestRoutesResult;
  let logs: any[];
  let sessionEvents: SessionInfo[];

  beforeEach(() => {
    logs = [];
    sessionEvents = [];
    ir = createIngestRoutes({
      logBroadcast: (e) => { logs.push(e); },
      sessionBroadcast: (e) => { sessionEvents.push(e); },
    });
  });

  // ── Orphan auto-registration ───────────────────────────────────────────

  describe('orphan auto-registration', () => {
    it('auto-registers unknown session on log ingestion', async () => {
      const app = buildApp(ir);
      const res = await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'orphan-1', entries: [makeEntry()] });

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(1);
      expect(ir.getSessions()).toHaveLength(1);
      expect(ir.getSessions()[0]).toEqual(expect.objectContaining({
        sessionId: 'orphan-1',
        status: 'active',
        kind: 'mcp',
        pid: 0,
        authenticated: false,
      }));
    });

    it('assigns a display name and color', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'orphan-2', entries: [makeEntry()] });

      const s = ir.getSessions()[0];
      expect(s.displayName).toBeTruthy();
      expect(s.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it('broadcasts the new session', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'orphan-3', entries: [makeEntry()] });

      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0].sessionId).toBe('orphan-3');
    });

    it('does not duplicate a known session', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 's1', event: 'started', pid: 111, startedAt: new Date().toISOString() });

      const name = ir.getSessions()[0].displayName;

      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 's1', entries: [makeEntry()] });

      expect(ir.getSessions()).toHaveLength(1);
      expect(ir.getSessions()[0].displayName).toBe(name);
      expect(ir.getSessions()[0].pid).toBe(111);
    });

    it('stamps _sessionId on entries from auto-registered sessions', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'orphan-4', entries: [makeEntry('a'), makeEntry('b')] });

      expect(logs).toHaveLength(2);
      expect(logs[0].data._sessionId).toBe('orphan-4');
      expect(logs[1].data._sessionId).toBe('orphan-4');
    });

    it('still processes all logs even with auto-registration', async () => {
      const app = buildApp(ir);
      const res = await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'orphan-5', entries: [makeEntry('a'), makeEntry('b'), makeEntry('c')] });

      expect(res.body.accepted).toBe(3);
      expect(logs).toHaveLength(3);
    });
  });

  // ── Session revival ────────────────────────────────────────────────────

  describe('session revival', () => {
    it('revives an ended session that sends new logs', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'r1', event: 'started', pid: 222, startedAt: new Date().toISOString() });
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'r1', event: 'stopped' });

      expect(ir.getSessions()).toHaveLength(0);

      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'r1', entries: [makeEntry()] });

      expect(ir.getSessions()).toHaveLength(1);
      expect(ir.getSessions()[0].status).toBe('active');
    });

    it('preserves PID and name on revival', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'r2', event: 'started', pid: 333, startedAt: new Date().toISOString() });

      const name = ir.getSessions()[0].displayName;

      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'r2', event: 'stopped' });
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'r2', entries: [makeEntry()] });

      expect(ir.getSessions()[0].pid).toBe(333);
      expect(ir.getSessions()[0].displayName).toBe(name);
    });
  });

  // ── Kill endpoint ──────────────────────────────────────────────────────

  describe('kill endpoint', () => {
    it('dismisses PID=0 orphan with reason no-pid', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'k1', entries: [makeEntry()] });

      const res = await request(app).post('/api/sessions/k1/kill');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ ok: true, reason: 'no-pid' }));
      expect(ir.getSessions()).toHaveLength(0);
    });

    it('returns 404 for completely unknown sessions', async () => {
      const app = buildApp(ir);
      const res = await request(app).post('/api/sessions/nope/kill');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Session not found');
    });

    it('dismissed orphan is suppressed from auto-registration', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'k3', entries: [makeEntry()] });
      await request(app).post('/api/sessions/k3/kill');
      expect(ir.getSessions()).toHaveLength(0);

      // New logs should NOT re-register — session is suppressed
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'k3', entries: [makeEntry('back')] });

      expect(ir.getSessions()).toHaveLength(0);
    });
  });

  // ── GET /api/sessions filtering ────────────────────────────────────────

  describe('GET /api/sessions filtering', () => {
    it('excludes ended sessions from response', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'f1', event: 'started', pid: 444, startedAt: new Date().toISOString() });
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'f1', event: 'stopped' });
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'f2', event: 'started', pid: 555, startedAt: new Date().toISOString() });

      const res = await request(app).get('/api/sessions');
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].sessionId).toBe('f2');
    });

    it('returns empty when all sessions ended', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'f3', event: 'started', pid: 666, startedAt: new Date().toISOString() });
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'f3', event: 'stopped' });

      const res = await request(app).get('/api/sessions');
      expect(res.body.sessions).toHaveLength(0);
    });
  });

  // ── Concurrent ingestion ───────────────────────────────────────────────

  describe('concurrent ingestion', () => {
    it('does not duplicate session from rapid parallel log batches', async () => {
      const app = buildApp(ir);
      const reqs = Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post('/api/ingest/logs')
          .send({ sessionId: 'conc-1', entries: [makeEntry(`batch-${i}`)] })
      );

      const results = await Promise.all(reqs);
      results.forEach(r => expect(r.status).toBe(200));
      expect(ir.getSessions()).toHaveLength(1);
      expect(logs).toHaveLength(5);
    });
  });

  // ── Heartbeat freshness ────────────────────────────────────────────────

  describe('heartbeat freshness', () => {
    it('auto-registered sessions have a recent heartbeat', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'hb-1', entries: [makeEntry()] });

      const s = ir.getSessions()[0];
      const age = Date.now() - new Date(s.lastHeartbeat).getTime();
      expect(age).toBeLessThan(5000);
    });

    it('log ingestion refreshes heartbeat on known sessions', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'hb-2', event: 'started', pid: 777, startedAt: new Date().toISOString() });

      const before = ir.getSessions()[0].lastHeartbeat;

      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 10));

      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'hb-2', entries: [makeEntry()] });

      const after = ir.getSessions()[0].lastHeartbeat;
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  // ── Suppression ────────────────────────────────────────────────────────

  describe('suppression after dismiss', () => {
    it('suppressed session stays gone even with continued log ingestion', async () => {
      const app = buildApp(ir);
      // Auto-register, dismiss, then send 3 more log batches
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'sup-1', entries: [makeEntry()] });
      await request(app).post('/api/sessions/sup-1/kill');

      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/ingest/logs')
          .send({ sessionId: 'sup-1', entries: [makeEntry(`attempt-${i}`)] });
      }

      expect(ir.getSessions()).toHaveLength(0);
    });

    it('suppressed session stays gone from metrics ingestion too', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'sup-2', entries: [makeEntry()] });
      await request(app).post('/api/sessions/sup-2/kill');

      await request(app)
        .post('/api/ingest/metrics')
        .send({ sessionId: 'sup-2', snapshot: { id: 'snap1', timestamp: new Date().toISOString(), metrics: {} } });

      expect(ir.getSessions()).toHaveLength(0);
    });

    it('suppressed session stays gone from heartbeat events', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'sup-3', entries: [makeEntry()] });
      await request(app).post('/api/sessions/sup-3/kill');

      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'sup-3', event: 'heartbeat', pid: 999 });

      expect(ir.getSessions()).toHaveLength(0);
    });

    it('suppressed session stays gone from started event', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'sup-4', entries: [makeEntry()] });
      await request(app).post('/api/sessions/sup-4/kill');

      // Client crashes and restarts — sends 'started' event
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'sup-4', event: 'started', pid: 88888, startedAt: new Date().toISOString() });

      expect(ir.getSessions()).toHaveLength(0);
    });
  });

  // ── Metrics auto-registration ──────────────────────────────────────────

  describe('metrics auto-registration', () => {
    it('auto-registers orphan from metrics ingestion', async () => {
      const app = buildApp(ir);
      const res = await request(app)
        .post('/api/ingest/metrics')
        .send({ sessionId: 'met-1', snapshot: { id: 'snap1', timestamp: new Date().toISOString(), metrics: {} } });

      expect(res.status).toBe(200);
      expect(ir.getSessions()).toHaveLength(1);
      expect(ir.getSessions()[0].sessionId).toBe('met-1');
    });
  });

  // ── Heartbeat PID recovery ─────────────────────────────────────────────

  describe('heartbeat PID recovery', () => {
    it('recovers PID from heartbeat for auto-registered session', async () => {
      const app = buildApp(ir);
      // Auto-register via logs (pid=0)
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'pid-1', entries: [makeEntry()] });

      expect(ir.getSessions()[0].pid).toBe(0);

      // Heartbeat arrives with real PID
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'pid-1', event: 'heartbeat', pid: 54321 });

      expect(ir.getSessions()[0].pid).toBe(54321);
    });

    it('auto-registers unknown session from heartbeat with PID', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'pid-2', event: 'heartbeat', pid: 12345 });

      expect(ir.getSessions()).toHaveLength(1);
      expect(ir.getSessions()[0].pid).toBe(12345);
    });

    it('does not overwrite existing PID with zero', async () => {
      const app = buildApp(ir);
      await request(app)
        .post('/api/ingest/session')
        .send({ sessionId: 'pid-3', event: 'started', pid: 77777, startedAt: new Date().toISOString() });

      // Log ingestion has no PID — should not overwrite
      await request(app)
        .post('/api/ingest/logs')
        .send({ sessionId: 'pid-3', entries: [makeEntry()] });

      expect(ir.getSessions()[0].pid).toBe(77777);
    });
  });
});
