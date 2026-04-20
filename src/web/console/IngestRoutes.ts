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
import {
  SessionNamePool,
  derivePreferredSessionName,
  getPuppetColor,
} from './SessionNames.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { PACKAGE_VERSION } from '../../generated/version.js';
import {
  CONSOLE_PROTOCOL_VERSION,
  LEGACY_CONSOLE_PROTOCOL_VERSION,
} from './LeaderElection.js';

/** Maximum payload size for ingestion requests */
const MAX_PAYLOAD_SIZE = '1mb';

/** Rate limit: max requests per window per source */
const RATE_LIMIT_MAX = 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** How often to check for stale sessions (ms) */
const REAPER_INTERVAL_MS = 5_000;

/** How long since last heartbeat before a session is considered dead (ms) */
const SESSION_STALE_MS = 15_000;
const TAKEOVER_IMPORTED_SESSION_GRACE_MS = 60_000;

/** Timeout for legacy port federation/proxy requests (ms) */
const LEGACY_FETCH_TIMEOUT_MS = 2_000;

/** How long before ended sessions are purged from the Map (ms) */
const ENDED_PURGE_MS = 5 * 60_000; // 5 minutes

/**
 * Tracked session information.
 */
export interface SessionInfo {
  /** Unique identifier for this session (UUID or `console-<pid>`). */
  sessionId: string;
  /** Stable cross-restart/session identity when the host provides one. */
  stableSessionId: string | null;
  /** Friendly puppet name (e.g., "Kermit", "Punch") or "Web Console". */
  displayName: string;
  /** Canonical hex color for this puppet character. */
  color: string;
  /** OS process ID of the MCP server or web console process. */
  pid: number;
  /** ISO timestamp when the session started. */
  startedAt: string;
  /** ISO timestamp of the most recent heartbeat (followers) or registration (leader/console). */
  lastHeartbeat: string;
  /** Lifecycle status — 'active' until ended or reaped for staleness. */
  status: 'active' | 'ended';
  /** True if this session won leader election and owns the token file. */
  isLeader: boolean;
  /** Whether this session connected with a valid Bearer token (#1805). */
  authenticated: boolean;
  /** Session kind — 'mcp' for MCP stdio sessions, 'console' for the web console itself (#1805). */
  kind: 'mcp' | 'console';
  /** DollhouseMCP package version reported by the session. */
  serverVersion: string;
  /** Console/session contract version used for compatibility-aware takeover. */
  consoleProtocolVersion: number;
}

/**
 * Payload for POST /api/ingest/logs
 */
export interface IngestLogPayload {
  sessionId: string;
  stableSessionId?: string;
  displayName?: string;
  entries: UnifiedLogEntry[];
}

/**
 * Payload for POST /api/ingest/metrics
 */
export interface IngestMetricsPayload {
  sessionId: string;
  stableSessionId?: string;
  displayName?: string;
  snapshot: MetricSnapshot;
}

/**
 * Payload for POST /api/ingest/session
 */
export interface SessionEventPayload {
  sessionId: string;
  stableSessionId?: string;
  displayName?: string;
  event: 'started' | 'stopped' | 'heartbeat';
  pid: number;
  startedAt: string;
  serverVersion?: string;
  consoleProtocolVersion?: number;
}

/**
 * Callbacks provided by the unified console orchestrator for broadcasting
 * ingested events through the existing SSE infrastructure.
 */
export interface IngestBroadcasts {
  logBroadcast: (entry: UnifiedLogEntry) => void;
  metricsOnSnapshot?: (snapshot: MetricSnapshot) => void;
  storeMetricsSnapshot?: (snapshot: MetricSnapshot, sessionId: string) => void;
  sessionBroadcast?: (event: SessionInfo) => void;
}

/**
 * Result of creating ingest routes.
 */
export interface IngestRoutesResult {
  router: Router;
  /** Get all tracked sessions */
  getSessions: () => SessionInfo[];
  /** Import active follower sessions from a displaced leader during takeover. */
  importSessions: (sessions: SessionInfo[]) => void;
  /** Register the leader as a session */
  registerLeaderSession: (
    sessionId: string,
    pid: number,
    displayName?: string,
    stableSessionId?: string,
  ) => void;
  /** Register the web console as a session so the indicator is never empty (#1805) */
  registerConsoleSession: () => void;
}

/** Normalize a string via UnicodeValidator (DMCP-SEC-004) */
function normalizeInput(s: string): string {
  return UnicodeValidator.normalize(s).normalizedContent;
}

function normalizeOptionalInput(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = normalizeInput(value).trim();
  return normalized || undefined;
}

function normalizeServerVersion(version?: string): string {
  if (typeof version === 'string' && version.trim().length > 0) {
    return version.trim();
  }
  return 'unknown';
}

function normalizeConsoleProtocolVersion(version?: number): number {
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) {
    return version;
  }
  return LEGACY_CONSOLE_PROTOCOL_VERSION;
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

  // Sessions the user explicitly killed — never come back (#1870).
  // Cleared only on server restart, which is appropriate since that's a new context.
  const killedSessions = new Set<string>();

  // Sessions waiting for a PID so we can SIGTERM them (#1870).
  // When the user dismisses a pid=0 orphan, we add it here. The next heartbeat
  // (every 10s) carries the PID — we SIGTERM immediately and move to killedSessions.
  const pendingKills = new Set<string>();
  const importedSessionGraceUntil = new Map<string, number>();

  /** Execute a deferred kill if we now have a PID. */
  function tryExecutePendingKill(sessionId: string, pid?: number): void {
    const killPid = pid || sessions.get(sessionId)?.pid;
    if (!killPid) return;
    try { process.kill(killPid, 'SIGTERM'); } catch { /* already dead */ }
    const existing = sessions.get(sessionId);
    if (existing) existing.status = 'ended';
    logger.info('[IngestRoutes] Deferred kill executed — PID arrived', {
      displayName: existing?.displayName, sessionId, pid: killPid,
    });
  }

  /** Promote a pending kill to permanent. */
  function finalizePendingKill(sessionId: string, pid?: number): void {
    tryExecutePendingKill(sessionId, pid);
    pendingKills.delete(sessionId);
    killedSessions.add(sessionId);
  }

  /** Create a new session entry for an orphan. Returns null on failure. */
  function autoRegister(
    sessionId: string,
    pid?: number,
    authenticated = false,
    serverVersion?: string,
    consoleProtocolVersion?: number,
    displayName?: string,
    stableSessionId?: string,
  ): SessionInfo | null {
    try {
      const preferredDisplayName = normalizeOptionalInput(displayName);
      const resolvedDisplayName = preferredDisplayName
        ? namePool.adopt(sessionId, preferredDisplayName)
        : namePool.assign(sessionId);
      const color = namePool.getColor(sessionId) ?? getPuppetColor(resolvedDisplayName) ?? '#3b82f6';
      const now = new Date().toISOString();
      const info: SessionInfo = {
        sessionId,
        stableSessionId: normalizeOptionalInput(stableSessionId) ?? null,
        displayName: resolvedDisplayName,
        color,
        pid: pid || 0,
        startedAt: now, lastHeartbeat: now,
        status: 'active', isLeader: false, authenticated, kind: 'mcp',
        serverVersion: normalizeServerVersion(serverVersion),
        consoleProtocolVersion: normalizeConsoleProtocolVersion(consoleProtocolVersion),
      };
      sessions.set(sessionId, info);
      logger.info('[IngestRoutes] Auto-registered orphaned session', {
        displayName: resolvedDisplayName, sessionId, source: pid ? 'heartbeat' : 'ingestion',
      });
      broadcasts.sessionBroadcast?.(info);
      return info;
    } catch (err) {
      logger.debug('[IngestRoutes] Failed to auto-register orphaned session', {
        sessionId, error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Auto-register or update an orphaned session from ingestion data.
   * Returns the session (existing or newly created), or null if killed/pending.
   */
  function ensureSession(
    sessionId: string,
    pid?: number,
    authenticated = false,
    serverVersion?: string,
    consoleProtocolVersion?: number,
    displayName?: string,
    stableSessionId?: string,
  ): SessionInfo | null {
    if (killedSessions.has(sessionId)) return null;
    if (pendingKills.has(sessionId)) {
      finalizePendingKill(sessionId, pid);
      return null;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      return autoRegister(
        sessionId,
        pid,
        authenticated,
        serverVersion,
        consoleProtocolVersion,
        displayName,
        stableSessionId,
      );
    }

    importedSessionGraceUntil.delete(sessionId);

    if (existing.status === 'ended') {
      existing.status = 'active';
      logger.info('[IngestRoutes] Revived ended session still sending data', {
        displayName: existing.displayName, sessionId,
      });
    }
    existing.lastHeartbeat = new Date().toISOString();
    if (pid && !existing.pid) {
      existing.pid = pid;
      logger.info('[IngestRoutes] Recovered PID for orphaned session', {
        displayName: existing.displayName, sessionId, pid,
      });
    }
    if (serverVersion) {
      existing.serverVersion = normalizeServerVersion(serverVersion);
    }
    if (consoleProtocolVersion !== undefined) {
      existing.consoleProtocolVersion = normalizeConsoleProtocolVersion(consoleProtocolVersion);
    }
    const preferredDisplayName = normalizeOptionalInput(displayName);
    if (preferredDisplayName) {
      const resolvedDisplayName = namePool.reassign(sessionId, preferredDisplayName, existing.isLeader);
      if (resolvedDisplayName !== existing.displayName) {
        existing.displayName = resolvedDisplayName;
        existing.color = getPuppetColor(resolvedDisplayName) ?? existing.color;
      }
    }
    const normalizedStableSessionId = normalizeOptionalInput(stableSessionId);
    if (normalizedStableSessionId) {
      existing.stableSessionId = normalizedStableSessionId;
    }
    return existing;
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
      const received = payload ? Object.keys(payload) : [];
      logger.warn('[IngestRoutes] Invalid log payload', { received, hasSessionId: !!payload?.sessionId, hasEntries: Array.isArray(payload?.entries) });
      res.status(400).json({ error: 'Invalid payload', required: ['sessionId', 'entries'], received });
      return;
    }
    payload.sessionId = normalizeInput(payload.sessionId);
    const payloadDisplayName = normalizeOptionalInput(payload.displayName);
    const payloadStableSessionId = normalizeOptionalInput(payload.stableSessionId);

    let count = 0;
    let skipped = 0;
    for (const entry of payload.entries) {
      if (!entry || typeof entry.message !== 'string') { skipped++; continue; }
      const stamped: UnifiedLogEntry = {
        ...entry,
        data: { ...entry.data, _sessionId: payload.sessionId },
      };
      broadcasts.logBroadcast(stamped);
      count++;
    }

    // Update heartbeat, revive ended sessions, or auto-register orphans (#1870)
    const session = ensureSession(
      payload.sessionId,
      undefined,
      false,
      undefined,
      undefined,
      payloadDisplayName,
      payloadStableSessionId,
    );

    if (skipped > 0) {
      logger.debug(`[IngestRoutes] Log ingest from ${session?.displayName ?? payload.sessionId}: accepted=${count}, skipped=${skipped}`);
    }

    res.status(200).json({ accepted: count, skipped });
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
      const received = payload ? Object.keys(payload) : [];
      logger.warn('[IngestRoutes] Invalid metrics payload', { received });
      res.status(400).json({ error: 'Invalid payload', required: ['sessionId', 'snapshot'], received });
      return;
    }
    payload.sessionId = normalizeInput(payload.sessionId);
    const payloadDisplayName = normalizeOptionalInput(payload.displayName);
    const payloadStableSessionId = normalizeOptionalInput(payload.stableSessionId);

    if (broadcasts.metricsOnSnapshot) {
      broadcasts.metricsOnSnapshot(payload.snapshot);
    }
    if (broadcasts.storeMetricsSnapshot) {
      broadcasts.storeMetricsSnapshot(payload.snapshot, payload.sessionId);
    }

    // Update heartbeat, revive ended sessions, or auto-register orphans (#1870)
    const session = ensureSession(
      payload.sessionId,
      undefined,
      false,
      undefined,
      undefined,
      payloadDisplayName,
      payloadStableSessionId,
    );
    logger.debug(`[IngestRoutes] Metrics ingested from ${session?.displayName ?? payload.sessionId}`);
    res.status(200).json({ accepted: true });
  });

  /**
   * POST /api/ingest/session — Session lifecycle events.
   */
  router.post('/api/ingest/session', (req: Request, res: Response) => {
    const payload = req.body as SessionEventPayload;
    if (!payload?.sessionId || !payload.event) {
      const received = payload ? Object.keys(payload) : [];
      logger.warn('[IngestRoutes] Invalid session event payload', { received });
      res.status(400).json({ error: 'Invalid payload', required: ['sessionId', 'event'], received });
      return;
    }
    payload.sessionId = normalizeInput(payload.sessionId);
    const payloadDisplayName = normalizeOptionalInput(payload.displayName);
    const payloadStableSessionId = normalizeOptionalInput(payload.stableSessionId);

    const now = new Date().toISOString();

    switch (payload.event) {
      case 'started': {
        // Killed sessions stay dead; pending kills get finalized (#1870)
        if (killedSessions.has(payload.sessionId)) break;
        if (pendingKills.has(payload.sessionId)) { finalizePendingKill(payload.sessionId, payload.pid); break; }

        const preferredDisplayName = payloadDisplayName ?? derivePreferredSessionName(payload.sessionId);
        const displayName = namePool.adopt(payload.sessionId, preferredDisplayName);
        const color = namePool.getColor(payload.sessionId) ?? getPuppetColor(displayName) ?? '#3b82f6';
        const isAuthenticated = Boolean((res as any).locals?.tokenEntry);
        sessions.set(payload.sessionId, {
          sessionId: payload.sessionId,
          stableSessionId: payloadStableSessionId ?? null,
          displayName,
          color,
          pid: payload.pid, startedAt: payload.startedAt || now, lastHeartbeat: now,
          status: 'active', isLeader: false, authenticated: isAuthenticated, kind: 'mcp',
          serverVersion: normalizeServerVersion(payload.serverVersion),
          consoleProtocolVersion: normalizeConsoleProtocolVersion(payload.consoleProtocolVersion),
        });
        logger.info('[IngestRoutes] Session registered', {
          displayName, sessionId: payload.sessionId, pid: payload.pid, color,
          activeSessions: Array.from(sessions.values()).filter(s => s.status === 'active').length,
        });
        broadcasts.sessionBroadcast?.(sessions.get(payload.sessionId)!);
        break;
      }
      case 'stopped': {
        const existing = sessions.get(payload.sessionId);
        if (existing) {
          existing.status = 'ended';
          existing.lastHeartbeat = now;
          namePool.release(payload.sessionId);
          logger.info('[IngestRoutes] Session stopped', {
            displayName: existing.displayName, sessionId: payload.sessionId, pid: existing.pid,
            activeSessions: Array.from(sessions.values()).filter(s => s.status === 'active').length - 1,
          });
          broadcasts.sessionBroadcast?.(existing);
        }
        break;
      }
      case 'heartbeat': {
        // Auto-register or update — heartbeat includes PID for recovery (#1870)
        ensureSession(
          payload.sessionId,
          payload.pid,
          false,
          payload.serverVersion,
          payload.consoleProtocolVersion,
          payloadDisplayName,
          payloadStableSessionId,
        );
        break;
      }
    }

    res.status(200).json({ ok: true });
  });

  /**
   * GET /api/sessions — List all tracked sessions.
   */
  router.get('/api/sessions', async (_req: Request, res: Response) => {
    // Server-side active filter — the frontend also filters, but ended sessions
    // should never leave the API to prevent stale UI (#1870).
    const localSessions = Array.from(sessions.values()).filter(s => s.status === 'active');
    const currentPort = env.DOLLHOUSE_WEB_CONSOLE_PORT ?? 41715;

    // Federate with the legacy port (3939) to show all sessions on the
    // machine, including unauthenticated ones from pre-auth installs.
    // Server-to-server avoids CORS restrictions (#1805).
    if (currentPort !== 3939) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), LEGACY_FETCH_TIMEOUT_MS);
        const legacyRes = await fetch('http://127.0.0.1:3939/api/sessions', {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (legacyRes.ok) {
          const legacyData = await legacyRes.json() as { sessions: SessionInfo[] };
          const localIds = new Set(localSessions.map(s => s.sessionId));
          for (const ls of (legacyData.sessions || [])) {
            if (!localIds.has(ls.sessionId) && ls.status === 'active') {
              localSessions.push({
                ...ls,
                authenticated: false,
                kind: ls.kind || 'mcp',
                serverVersion: normalizeServerVersion(ls.serverVersion),
                consoleProtocolVersion: normalizeConsoleProtocolVersion(ls.consoleProtocolVersion),
              });
            }
          }
        }
      } catch {
        // Legacy instance not running or unreachable — that's fine
      }
    }

    res.json({ sessions: localSessions });
  });

  /**
   * POST /api/sessions/:sessionId/kill — Terminate a session's server process.
   */
  router.post('/api/sessions/:sessionId/kill', async (req: Request, res: Response) => {
    const sessionId = req.params['sessionId'] as string;
    const session = sessions.get(sessionId);

    if (!session) {
      // Session not in local Map — try proxying kill to legacy port (#1870)
      const currentPort = env.DOLLHOUSE_WEB_CONSOLE_PORT ?? 41715;
      if (currentPort !== 3939) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), LEGACY_FETCH_TIMEOUT_MS);
          const proxyRes = await fetch(`http://127.0.0.1:3939/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
            method: 'POST',
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (proxyRes.ok) {
            const data = await proxyRes.json();
            res.json(data);
            return;
          }
        } catch {
          // Legacy instance not running — fall through to 404
        }
      }
      logger.warn('[IngestRoutes] Kill requested for unknown session', { sessionId });
      res.status(404).json({ error: 'Session not found', sessionId });
      return;
    }

    if (!session.pid) {
      // Auto-registered orphan with unknown PID — queue for deferred kill (#1870).
      // The next heartbeat (every ~10s) carries the PID. ensureSession() will
      // SIGTERM the process as soon as the PID arrives. Session is gone for good.
      session.status = 'ended';
      namePool.release(sessionId);
      pendingKills.add(sessionId);
      logger.info('[IngestRoutes] Queued deferred kill — waiting for PID via heartbeat', {
        displayName: session.displayName, sessionId,
      });
      res.json({ ok: true, dismissed: session.displayName, reason: 'pending-kill' });
      return;
    }

    // SIGTERM the process. Even if it fails (ESRCH = already dead, EPERM = not ours),
    // mark the session as permanently killed so it never reappears (#1870).
    try {
      process.kill(session.pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        // Process already dead — treat as successful kill.
      } else {
        logger.error('[IngestRoutes] Failed to kill session', {
          displayName: session.displayName, sessionId, pid: session.pid, error: (err as Error).message,
        });
        res.status(500).json({ error: 'Failed to kill session', sessionId, displayName: session.displayName, pid: session.pid, detail: (err as Error).message });
        return;
      }
    }
    session.status = 'ended';
    namePool.release(sessionId);
    killedSessions.add(sessionId);
    logger.info('[IngestRoutes] Session killed', {
      displayName: session.displayName, sessionId, pid: session.pid,
      activeSessions: Array.from(sessions.values()).filter(s => s.status === 'active').length - 1,
    });
    res.json({ ok: true, killed: session.displayName, pid: session.pid });
  });

  /** Mark stale active sessions as ended. */
  function reapStaleSessions(now: number): void {
    for (const [id, session] of sessions) {
      if (session.status !== 'active') continue;
      if (session.isLeader || session.kind === 'console') continue;
      const age = now - new Date(session.lastHeartbeat).getTime();
      const graceUntil = importedSessionGraceUntil.get(id) ?? 0;
      if (graceUntil > now) continue;
      if (graceUntil !== 0) {
        importedSessionGraceUntil.delete(id);
      }
      if (age <= SESSION_STALE_MS) continue;
      session.status = 'ended';
      namePool.release(id);
      logger.info('[IngestRoutes] Reaped stale session', {
        displayName: session.displayName, sessionId: id, pid: session.pid,
        lastHeartbeatAgo: `${Math.round(age / 1000)}s`,
        activeSessions: Array.from(sessions.values()).filter(s => s.status === 'active').length - 1,
      });
      broadcasts.sessionBroadcast?.(session);
    }
  }

  /** Delete ended sessions to bound memory (#1870). */
  function purgeStaleEntries(now: number): void {
    for (const [id, session] of sessions) {
      if (session.status === 'ended' && now - new Date(session.lastHeartbeat).getTime() > ENDED_PURGE_MS) {
        importedSessionGraceUntil.delete(id);
        sessions.delete(id);
      }
    }
  }

  const reaperInterval = setInterval(() => {
    const now = Date.now();
    reapStaleSessions(now);
    purgeStaleEntries(now);
  }, REAPER_INTERVAL_MS);
  reaperInterval.unref();

  function getSessions(): SessionInfo[] {
    return Array.from(sessions.values()).filter(s => s.status === 'active');
  }

  function importSessions(importedSessions: SessionInfo[]): void {
    const now = Date.now();
    for (const imported of importedSessions) {
      if (imported.status !== 'active') continue;
      if (imported.isLeader || imported.kind === 'console') continue;
      if (killedSessions.has(imported.sessionId) || pendingKills.has(imported.sessionId)) continue;

      const normalizedSessionId = normalizeInput(imported.sessionId);
      const existing = sessions.get(normalizedSessionId);
      if (existing?.isLeader || existing?.kind === 'console') {
        continue;
      }

      const displayName = imported.displayName
        ? namePool.adopt(normalizedSessionId, imported.displayName)
        : namePool.assign(normalizedSessionId);
      const color = imported.color || namePool.getColor(normalizedSessionId) || '#3b82f6';
      const merged: SessionInfo = {
        sessionId: normalizedSessionId,
        stableSessionId: imported.stableSessionId ?? existing?.stableSessionId ?? null,
        displayName,
        color,
        pid: imported.pid || existing?.pid || 0,
        startedAt: imported.startedAt || existing?.startedAt || new Date(now).toISOString(),
        lastHeartbeat: imported.lastHeartbeat || existing?.lastHeartbeat || new Date(now).toISOString(),
        status: 'active',
        isLeader: false,
        authenticated: imported.authenticated ?? existing?.authenticated ?? false,
        kind: 'mcp',
        serverVersion: normalizeServerVersion(imported.serverVersion || existing?.serverVersion),
        consoleProtocolVersion: normalizeConsoleProtocolVersion(
          imported.consoleProtocolVersion ?? existing?.consoleProtocolVersion,
        ),
      };

      sessions.set(normalizedSessionId, merged);
      importedSessionGraceUntil.set(normalizedSessionId, now + TAKEOVER_IMPORTED_SESSION_GRACE_MS);
      broadcasts.sessionBroadcast?.(merged);
    }
  }

  function registerLeaderSession(
    sessionId: string,
    pid: number,
    displayName?: string,
    stableSessionId?: string,
  ): void {
    const preferredDisplayName = normalizeOptionalInput(displayName) ?? derivePreferredSessionName(sessionId, true);
    const resolvedDisplayName = namePool.adopt(sessionId, preferredDisplayName, true);
    const color = namePool.getColor(sessionId) ?? getPuppetColor(resolvedDisplayName) ?? '#3b82f6';
    sessions.set(sessionId, {
      sessionId,
      stableSessionId: normalizeOptionalInput(stableSessionId) ?? null,
      displayName: resolvedDisplayName,
      color,
      pid,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'active',
      isLeader: true,
      authenticated: true,
      kind: 'mcp',
      serverVersion: PACKAGE_VERSION,
      consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
    });
    logger.info('[IngestRoutes] Leader session registered', {
      displayName: resolvedDisplayName,
      sessionId,
      stableSessionId: normalizeOptionalInput(stableSessionId) ?? null,
      pid,
      color,
    });
  }

  /**
   * Register the web console itself as a session (#1805). Ensures the
   * session indicator always shows at least one entry — the console the
   * user is currently looking at.
   */
  function registerConsoleSession(): void {
    const consoleId = `console-${process.pid}`;
    if (sessions.has(consoleId)) return;
    const displayName = 'Web Console';
    sessions.set(consoleId, {
      sessionId: consoleId,
      stableSessionId: null,
      displayName,
      color: '#6366f1', // indigo — distinct from puppet greens/blues
      pid: process.pid,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'active',
      isLeader: false,
      authenticated: true,
      kind: 'console',
      serverVersion: PACKAGE_VERSION,
      consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
    });
    logger.info('[IngestRoutes] Console session registered', { sessionId: consoleId, pid: process.pid });
  }

  return { router, getSessions, importSessions, registerLeaderSession, registerConsoleSession };
}
