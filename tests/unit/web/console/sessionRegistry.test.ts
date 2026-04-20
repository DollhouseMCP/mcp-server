/**
 * Unit tests for session registry and auth status (#1805).
 *
 * Tests the IngestRoutes session management: registration, auth fields,
 * console session behavior, and stale reaper exemptions.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  createIngestRoutes,
  type IngestRoutesResult,
  type SessionInfo,
} from '../../../../src/web/console/IngestRoutes.js';
import { PACKAGE_VERSION } from '../../../../src/generated/version.js';
import { CONSOLE_PROTOCOL_VERSION } from '../../../../src/web/console/LeaderElection.js';

function buildApp(ingestResult: IngestRoutesResult) {
  const app = express();
  app.use(express.json());
  app.use(ingestResult.router);
  return app;
}

describe('Session registry (#1805)', () => {
  let ingestResult: IngestRoutesResult;

  beforeEach(() => {
    ingestResult = createIngestRoutes({
      logBroadcast: () => {},
    });
  });

  describe('registerLeaderSession', () => {
    it('registers a leader session with authenticated=true and kind=mcp', () => {
      ingestResult.registerLeaderSession('test-leader-001', process.pid, 'claude-code');
      const sessions = ingestResult.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].authenticated).toBe(true);
      expect(sessions[0].kind).toBe('mcp');
      expect(sessions[0].isLeader).toBe(true);
      expect(sessions[0].status).toBe('active');
      expect(sessions[0].serverVersion).toBe(PACKAGE_VERSION);
      expect(sessions[0].consoleProtocolVersion).toBe(CONSOLE_PROTOCOL_VERSION);
      expect(sessions[0].clientPlatform).toBe('claude-code');
      expect(sessions[0].clientPlatformLabel).toBe('Claude Code');
    });

    it('assigns a puppet display name', () => {
      ingestResult.registerLeaderSession('test-leader-002', process.pid);
      const sessions = ingestResult.getSessions();
      expect(sessions[0].displayName).toBeTruthy();
      expect(sessions[0].displayName).not.toBe('');
    });
  });

  describe('metrics ingestion', () => {
    it('stores follower snapshots in the provided metrics callback', async () => {
      const storeMetricsSnapshot = jest.fn();
      ingestResult = createIngestRoutes({
        logBroadcast: () => {},
        storeMetricsSnapshot,
      });
      const app = buildApp(ingestResult);
      const snapshot = {
        id: 'snap-1',
        timestamp: new Date().toISOString(),
        metrics: [],
        errors: [],
        durationMs: 7,
      };

      const res = await request(app)
        .post('/api/ingest/metrics')
        .send({ sessionId: 'metrics-1', snapshot });

      expect(res.status).toBe(200);
      expect(storeMetricsSnapshot).toHaveBeenCalledWith(snapshot, 'metrics-1');
    });
  });

  describe('registerConsoleSession', () => {
    it('registers a console session with authenticated=true and kind=console', () => {
      ingestResult.registerConsoleSession();
      const sessions = ingestResult.getSessions();
      const consoleSessions = sessions.filter(s => s.kind === 'console');
      expect(consoleSessions).toHaveLength(1);
      expect(consoleSessions[0].authenticated).toBe(true);
      expect(consoleSessions[0].kind).toBe('console');
      expect(consoleSessions[0].displayName).toBe('Web Console');
      expect(consoleSessions[0].status).toBe('active');
      expect(consoleSessions[0].clientPlatform).toBe('web-console');
      expect(consoleSessions[0].clientPlatformLabel).toBe('Web Console');
    });

    it('is idempotent — calling twice does not create duplicates', () => {
      ingestResult.registerConsoleSession();
      ingestResult.registerConsoleSession();
      const sessions = ingestResult.getSessions();
      const consoleSessions = sessions.filter(s => s.kind === 'console');
      expect(consoleSessions).toHaveLength(1);
    });

    it('uses process pid', () => {
      ingestResult.registerConsoleSession();
      const sessions = ingestResult.getSessions();
      const consoleSession = sessions.find(s => s.kind === 'console');
      expect(consoleSession).toBeDefined();
      expect(consoleSession!.pid).toBe(process.pid);
    });
  });

  describe('getSessions', () => {
    it('returns only active sessions', () => {
      ingestResult.registerLeaderSession('leader-001', process.pid);
      ingestResult.registerConsoleSession();
      const sessions = ingestResult.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.every(s => s.status === 'active')).toBe(true);
    });

    it('returns empty array when no sessions registered', () => {
      expect(ingestResult.getSessions()).toHaveLength(0);
    });

    it('includes both mcp and console sessions', () => {
      ingestResult.registerLeaderSession('leader-001', process.pid);
      ingestResult.registerConsoleSession();
      const sessions = ingestResult.getSessions();
      const kinds = sessions.map(s => s.kind);
      expect(kinds).toContain('mcp');
      expect(kinds).toContain('console');
    });
  });

  describe('GET /api/sessions endpoint', () => {
    it('returns sessions with authenticated and kind fields', async () => {
      ingestResult.registerLeaderSession('leader-001', process.pid);
      ingestResult.registerConsoleSession();
      const app = buildApp(ingestResult);

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      // At least 2 local sessions; may include federated legacy sessions
      // if a legacy DollhouseMCP instance is running on port 3939.
      expect(res.body.sessions.length).toBeGreaterThanOrEqual(2);

      const leader = res.body.sessions.find((s: SessionInfo) => s.sessionId === 'leader-001');
      expect(leader).toBeDefined();
      expect(leader.authenticated).toBe(true);
      expect(leader.kind).toBe('mcp');
      expect(leader.serverVersion).toBe(PACKAGE_VERSION);
      expect(leader.consoleProtocolVersion).toBe(CONSOLE_PROTOCOL_VERSION);

      const consoleSess = res.body.sessions.find((s: SessionInfo) => s.kind === 'console');
      expect(consoleSess).toBeDefined();
      expect(consoleSess.authenticated).toBe(true);
      expect(consoleSess.displayName).toBe('Web Console');
      expect(consoleSess.serverVersion).toBe(PACKAGE_VERSION);
      expect(consoleSess.consoleProtocolVersion).toBe(CONSOLE_PROTOCOL_VERSION);
    });

    it('records follower version metadata from session heartbeat payloads', async () => {
      const app = buildApp(ingestResult);

      await request(app)
        .post('/api/ingest/session')
        .send({
          sessionId: 'follower-001',
          event: 'started',
          pid: 12345,
          startedAt: new Date().toISOString(),
          serverVersion: '2.0.99',
          consoleProtocolVersion: 1,
          clientPlatform: 'codex',
        });

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      const follower = res.body.sessions.find((s: SessionInfo) => s.sessionId === 'follower-001');
      expect(follower).toBeDefined();
      expect(follower.serverVersion).toBe('2.0.99');
      expect(follower.consoleProtocolVersion).toBe(1);
      expect(follower.clientPlatform).toBe('codex');
      expect(follower.clientPlatformLabel).toBe('Codex');
    });
  });

  describe('stale session reaper', () => {
    it('does not reap console sessions (they have no heartbeat)', async () => {
      ingestResult.registerConsoleSession();

      // Advance time past the stale threshold (15s)
      jest.useFakeTimers();
      try {
        jest.advanceTimersByTime(20_000);
        const sessions = ingestResult.getSessions();
        const consoleSessions = sessions.filter(s => s.kind === 'console');
        expect(consoleSessions).toHaveLength(1);
        expect(consoleSessions[0].status).toBe('active');
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not reap leader sessions', async () => {
      ingestResult.registerLeaderSession('leader-001', process.pid);

      jest.useFakeTimers();
      try {
        jest.advanceTimersByTime(20_000);
        const sessions = ingestResult.getSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].isLeader).toBe(true);
        expect(sessions[0].status).toBe('active');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('session data model completeness', () => {
    it('leader session has all required fields', () => {
      ingestResult.registerLeaderSession('leader-001', process.pid);
      const session = ingestResult.getSessions()[0];
      expect(session).toEqual(expect.objectContaining({
        sessionId: 'leader-001',
        pid: process.pid,
        status: 'active',
        isLeader: true,
        authenticated: true,
        kind: 'mcp',
        serverVersion: PACKAGE_VERSION,
        consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
      }));
      expect(session.displayName).toBeTruthy();
      expect(session.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(session.startedAt).toBeTruthy();
      expect(session.lastHeartbeat).toBeTruthy();
    });

    it('console session has all required fields', () => {
      ingestResult.registerConsoleSession();
      const session = ingestResult.getSessions()[0];
      expect(session).toEqual(expect.objectContaining({
        displayName: 'Web Console',
        pid: process.pid,
        status: 'active',
        isLeader: false,
        authenticated: true,
        kind: 'console',
        serverVersion: PACKAGE_VERSION,
        consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
        clientPlatform: 'web-console',
        clientPlatformLabel: 'Web Console',
      }));
      expect(session.sessionId).toMatch(/^console-\d+$/);
      expect(session.color).toBe('#6366f1');
      expect(session.startedAt).toBeTruthy();
      expect(session.lastHeartbeat).toBeTruthy();
    });
  });
});
