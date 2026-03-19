/**
 * Audit logger for safety events
 *
 * Provides an injectable logging interface for tracking safety events.
 * Implementations can log to console, files, monitoring systems, etc.
 *
 * @since v1.0.0
 */

import { AuditLogger, SafetyAuditEvent } from './types.js';

/**
 * Default no-op audit logger (silent by default)
 */
export const defaultAuditLogger: AuditLogger = {
  log: () => {
    // Silent by default - implementations can override
  },
};

/**
 * Console-based audit logger for development/debugging
 */
export const consoleAuditLogger: AuditLogger = {
  log: (event: SafetyAuditEvent) => {
    const severity = event.tier === 'danger_zone' ? 'ERROR' : event.tier === 'verify' ? 'WARN' : 'INFO';
    console.log(`[${severity}] Safety Audit: ${event.type} (tier: ${event.tier})`, {
      timestamp: event.timestamp,
      details: event.details,
    });
  },
};

/**
 * Create a custom audit logger with a callback
 */
export function createAuditLogger(callback: (event: SafetyAuditEvent) => void): AuditLogger {
  return { log: callback };
}
