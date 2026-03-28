/**
 * Event ingestion routes for the unified web console.
 *
 * The console leader mounts these routes so follower MCP servers can
 * forward their logs, metrics, and session lifecycle events. All ingested
 * entries are stamped with `_sessionId` in their data field and then
 * broadcast to SSE clients via the existing log/metrics broadcast hooks.
 *
 * Routes:
 * - POST /api/ingest/logs     — Batched log entries from a follower
 * - POST /api/ingest/metrics  — Metric snapshots from a follower
 * - POST /api/ingest/session  — Session lifecycle events (started/stopped/heartbeat)
 * - GET  /api/sessions        — Active session list for the UI
 *
 * @since v2.1.0 — Issue #1700
 */

import express, { Router } from 'express';
import type { Request, Response } from 'express';
import type { UnifiedLogEntry } from '../../logging/types.js';
import type { MetricSnapshot } from '../../metrics/types.js';
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SessionNamePool } from './SessionNames.js';
import { logger } from '../../utils/logger.js';

/** Maximum payload size for ingestion requests */
const MAX_PAYLOAD_SIZE = '1mb';

/** Rate limit: max requests per window per source */
const RATE_LIMIT_MAX = 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** How often to check for stale sessions (ms) */
const REAPER_INTERVAL_MS = 5_000;

/** How long since last heartbeat before a session is considered dead (ms) */
const SESSION_STALE_MS = 15_000;

/**
 * Tracked session information.
 */
export interface SessionInfo {
  sessionId: string;
  /** Friendly puppet name (e.g., "Kermit", "Punch") */
  displayName: string;
  /** Canonical hex color for this puppet character */
  color: string;
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  status: 'active' | 'ended';
  isLeader: boolean;
}

/**
 * Payload for POST /api/ingest/logs
 */
export interface IngestLogPayload {
  sessionId: string;
  entries: UnifiedLogEntry[];
}

/**
 * Payload for POST /api/ingest/metrics
 */
export interface IngestMetricsPayload {
  sessionId: string;
  snapshot: MetricSnapshot;
}

/**
 * Payload for POST /api/ingest/session
 */
export interface SessionEventPayload {
  sessionId: string;
  event: 'started' | 'stopped' | 'heartbeat';
  pid: number;
  startedAt: string;
}

/**
 * Callbacks provided by the unified console orchestrator for broadcasting
 * ingested events through the existing SSE infrastructure.
 */
export interface IngestBroadcasts {
  logBroadcast: (entry: UnifiedLogEntry) => void;
  metricsOnSnapshot?: (snapshot: MetricSnapshot) => void;
  sessionBroadcast?: (event: SessionInfo) => void;
}

/**
 * Result of creating ingest routes.
 */
export interface IngestRoutesResult {
  router: Router;
  /** Get all tracked sessions */
  getSessions: () => SessionInfo[];
  /** Register the leader as a session */
  registerLeaderSession: (sessionId: string, pid: number) => void;
}

/**
 * Create the ingestion routes and session registry.
 *
 * @param broadcasts - Callbacks to forward ingested events to SSE clients
 * @returns Router and session management functions
 */
export function createIngestRoutes(broadcasts: IngestBroadcasts): IngestRoutesResult {
  const router = Router();
  const sessions = new Map<string, SessionInfo>();
  const namePool = new SessionNamePool();
  const rateLimiter = new SlidingWindowRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

  /** Normalize a string via UnicodeValidator */
  function normalizeInput(s: string): string {
    return UnicodeValidator.normalize(s).normalizedContent;
  }

  // JSON body parsing with size limit
  router.use(express.json({ limit: MAX_PAYLOAD_SIZE }));

  /**
   * POST /api/ingest/logs — Receive batched log entries from a follower.
   */
  router.post('/api/ingest/logs', (req: Request, res: Response) => {
    if (!rateLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    const payload = req.body as IngestLogPayload;
    if (!payload?.sessionId || !Array.isArray(payload.entries)) {
      res.status(400).json({ error: 'Invalid payload: requires sessionId and entries[]' });
      return;
    }
    payload.sessionId = normalizeInput(payload.sessionId);

    let count = 0;
    for (const entry of payload.entries) {
      if (!entry || typeof entry.message !== 'string') continue;
      // Stamp session context into the data field
      const stamped: UnifiedLogEntry = {
        ...entry,
        data: { ...entry.data, _sessionId: payload.sessionId },
      };
      broadcasts.logBroadcast(stamped);
      count++;
    }

    // Update session heartbeat
    const session = sessions.get(payload.sessionId);
    if (session) {
      session.lastHeartbeat = new Date().toISOString();
    }

    res.status(200).json({ accepted: count });
  });

  /**
   * POST /api/ingest/metrics — Receive metric snapshots from a follower.
   */
  router.post('/api/ingest/metrics', (req: Request, res: Response) => {
    if (!rateLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    const payload = req.body as IngestMetricsPayload;
    if (!payload?.sessionId || !payload.snapshot) {
      res.status(400).json({ error: 'Invalid payload: requires sessionId and snapshot' });
      return;
    }
    payload.sessionId = normalizeInput(payload.sessionId);

    if (broadcasts.metricsOnSnapshot) {
      broadcasts.metricsOnSnapshot(payload.snapshot);
    }

    res.status(200).json({ accepted: true });
  });

  /**
   * POST /api/ingest/session — Session lifecycle events.
   */
  router.post('/api/ingest/session', (req: Request, res: Response) => {
    const payload = req.body as SessionEventPayload;
    if (!payload?.sessionId || !payload.event) {
      res.status(400).json({ error: 'Invalid payload: requires sessionId and event' });
      return;
    }
    payload.sessionId = normalizeInput(payload.sessionId);

    const now = new Date().toISOString();

    switch (payload.event) {
      case 'started': {
        const displayName = namePool.assign(payload.sessionId);
        const color = namePool.getColor(payload.sessionId) ?? '#3b82f6';
        const info: SessionInfo = {
          sessionId: payload.sessionId,
          displayName,
          color,
          pid: payload.pid,
          startedAt: payload.startedAt || now,
          lastHeartbeat: now,
          status: 'active',
          isLeader: false,
        };
        sessions.set(payload.sessionId, info);
        logger.info(`[IngestRoutes] Session registered: ${displayName} (${payload.sessionId}, pid=${payload.pid})`);
        broadcasts.sessionBroadcast?.(info);
        break;
      }
      case 'stopped': {
        const existing = sessions.get(payload.sessionId);
        if (existing) {
          existing.status = 'ended';
          existing.lastHeartbeat = now;
          namePool.release(payload.sessionId);
          broadcasts.sessionBroadcast?.(existing);
        }
        break;
      }
      case 'heartbeat': {
        const existing = sessions.get(payload.sessionId);
        if (existing) {
          existing.lastHeartbeat = now;
        }
        break;
      }
    }

    res.status(200).json({ ok: true });
  });

  /**
   * GET /api/sessions — List all tracked sessions.
   */
  router.get('/api/sessions', (_req: Request, res: Response) => {
    const allSessions = Array.from(sessions.values());
    res.json({ sessions: allSessions });
  });

  /**
   * POST /api/sessions/:sessionId/kill — Terminate a session's server process.
   */
  router.post('/api/sessions/:sessionId/kill', (req: Request, res: Response) => {
    const sessionId = req.params['sessionId'] as string;
    const session = sessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!session.pid) {
      res.status(400).json({ error: 'No PID for session' });
      return;
    }

    try {
      process.kill(session.pid, 'SIGTERM');
      session.status = 'ended';
      namePool.release(sessionId);
      logger.info(`[IngestRoutes] Killed session ${session.displayName} (pid=${session.pid})`);
      res.json({ ok: true, killed: session.displayName, pid: session.pid });
    } catch (err) {
      res.status(500).json({ error: `Failed to kill pid ${session.pid}: ${(err as Error).message}` });
    }
  });

  // Reaper: periodically check for stale sessions whose heartbeat has expired
  const reaperInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.status !== 'active') continue;
      if (session.isLeader) continue; // leader manages itself
      const age = now - new Date(session.lastHeartbeat).getTime();
      if (age > SESSION_STALE_MS) {
        session.status = 'ended';
        namePool.release(id);
        logger.info(`[IngestRoutes] Reaped stale session: ${session.displayName} (${id}, last heartbeat ${Math.round(age / 1000)}s ago)`);
        broadcasts.sessionBroadcast?.(session);
      }
    }
  }, REAPER_INTERVAL_MS);
  reaperInterval.unref();

  function getSessions(): SessionInfo[] {
    return Array.from(sessions.values()).filter(s => s.status === 'active');
  }

  function registerLeaderSession(sessionId: string, pid: number): void {
    const displayName = namePool.assign(sessionId, true);
    const color = namePool.getColor(sessionId) ?? '#3b82f6';
    sessions.set(sessionId, {
      sessionId,
      displayName,
      color,
      pid,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'active',
      isLeader: true,
    });
    logger.info(`[IngestRoutes] Leader session: ${displayName} (${sessionId})`);
  }

  return { router, getSessions, registerLeaderSession };
}
