/**
 * sseTickets
 *
 * Per-stream short-lived (≤30s) one-time tickets for EventSource auth.
 * The browser's EventSource API cannot set custom headers, so SSE
 * consumers historically pass the bearer token as a query string —
 * which leaks the token into proxy logs, browser history, and referer
 * headers. This module provides a safer pattern: an authenticated POST
 * issues a per-stream ticket bound to (sub, stream-name); the EventSource
 * URL includes ?ticket=<value>; the SSE handler validates and consumes
 * the ticket once.
 *
 * Used by: nothing yet. The web console SSE consumers
 * (`src/web/sinks/WebSSELogSink.ts`, `WebSSEMetricsSink.ts`,
 * `src/web/public/consoleAuth.js`) still use the legacy ?token= path
 * via `src/web/middleware/authMiddleware.ts`. The console rewrite
 * (mid-May 2026) will migrate them to consume this ticket pattern;
 * after that, the web-side ?token= can also be removed.
 *
 * The MCP-side ?token= fallback in src/auth/authMiddleware.ts has
 * already been removed (§8.1 compliance).
 *
 * @module server/sseTickets
 */

import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 1000;
const MAX_TICKETS = 1000; // Cap to bound memory in the in-process store.

interface TicketRecord {
  sub: string;
  streamName: string;
  expiresAt: number;
}

export interface IssueTicketInput {
  sub: string;
  streamName: string;
  /** TTL override; default 30 seconds. Capped at 60s. */
  ttlMs?: number;
}

export interface RedeemTicketInput {
  ticket: string;
  streamName: string;
}

export interface RedeemResult {
  ok: boolean;
  sub?: string;
  reason?: string;
}

/**
 * In-memory ticket store. Process-local; tickets do not survive restart.
 * Acceptable for SSE since reconnects always re-fetch a ticket.
 */
export class SseTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();

  issue(input: IssueTicketInput): string {
    this.gc();
    if (this.tickets.size >= MAX_TICKETS) {
      // Drop the oldest tickets to keep the store bounded.
      const drop = this.tickets.size - MAX_TICKETS + 1;
      let i = 0;
      for (const key of this.tickets.keys()) {
        if (i++ >= drop) break;
        this.tickets.delete(key);
      }
    }
    const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, 60 * 1000);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      sub: input.sub,
      streamName: input.streamName,
      expiresAt: Date.now() + ttl,
    });
    return ticket;
  }

  redeem(input: RedeemTicketInput): RedeemResult {
    const record = this.tickets.get(input.ticket);
    if (!record) return { ok: false, reason: 'unknown ticket' };
    if (record.expiresAt <= Date.now()) {
      this.tickets.delete(input.ticket);
      return { ok: false, reason: 'ticket expired' };
    }
    if (record.streamName !== input.streamName) {
      return { ok: false, reason: 'ticket bound to a different stream' };
    }
    // Single-use: redeem and discard.
    this.tickets.delete(input.ticket);
    return { ok: true, sub: record.sub };
  }

  size(): number {
    return this.tickets.size;
  }

  private gc(): void {
    const now = Date.now();
    for (const [ticket, record] of this.tickets.entries()) {
      if (record.expiresAt <= now) {
        this.tickets.delete(ticket);
      }
    }
  }
}
