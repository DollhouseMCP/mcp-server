/**
 * Handoff Service — Session handoff for agent execution.
 *
 * Enables agent executions to be paused, serialized, and resumed
 * across session boundaries. Builds on GatheredData (#68) for
 * execution state aggregation.
 *
 * Part of the Agentic Loop Completion (Epic #380, Issues #69, #71).
 *
 * @since v2.0.0
 */

import { createHash } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { performance } from 'perf_hooks';
import type { GatheredData, GatheredDataEntry } from './gatheredData.js';
import { logger } from '../../utils/logger.js';
import {
  getHandoffMaxRecentEntries,
  getHandoffMaxRecentDecisions,
  getHandoffWarnPayloadBytes,
} from '../../config/handoff-limits.js';

// =============================================================================
// Handoff State Types (#69)
// =============================================================================

/** Schema version for forward compatibility */
const HANDOFF_VERSION = '1.0.0';

/**
 * Complete handoff state snapshot for session transfer.
 *
 * Contains everything needed to resume an agent execution:
 * - Goal progress and status
 * - Gathered data (decisions, findings, metrics)
 * - Active element context
 * - Continuation instructions
 */
export interface HandoffState {
  /** Schema version for forward compatibility */
  version: string;
  /** Agent name */
  agentName: string;
  /** Goal ID being handed off */
  goalId: string;
  /** ISO 8601 timestamp when handoff was prepared */
  preparedAt: string;
  /** SHA-256 checksum of the data payload (excludes checksum field itself) */
  checksum: string;

  /** Goal progress snapshot */
  goalProgress: {
    description: string;
    status: string;
    stepsCompleted: number;
    successCriteria: string[];
  };

  /** Aggregated execution data from GatheredData */
  gatheredDataSummary: {
    totalEntries: number;
    /** Last N entries (most recent, capped for size) */
    recentEntries: GatheredDataEntry[];
    /** Summary statistics */
    summary: GatheredData['summary'];
  };

  /** Recent decision history (last 10) */
  decisionHistory: Array<{
    decision: string;
    reasoning: string;
    outcome?: string;
    confidence: number;
    timestamp: string;
  }>;

  /** Active elements at time of handoff */
  activeElements: Record<string, string[]>;

  /** Human-readable continuation instructions */
  continuationInstructions: string;
}

// =============================================================================
// Handoff State Preparation (#69)
// =============================================================================

/**
 * Prepare a handoff state from gathered data and execution context.
 *
 * @param agentName - Agent name
 * @param gatheredData - Aggregated execution data from getGatheredData()
 * @param activeElements - Currently active elements (from execute result or state)
 * @param successCriteria - Goal success criteria
 * @returns Complete HandoffState with checksum
 */
export function prepareHandoffState(
  agentName: string,
  gatheredData: GatheredData,
  activeElements: Record<string, string[]>,
  successCriteria: string[] = []
): HandoffState {
  // Build gathered data summary (capped for size via configurable limits)
  const maxRecentEntries = getHandoffMaxRecentEntries();
  const maxRecentDecisions = getHandoffMaxRecentDecisions();

  const recentEntries = gatheredData.entries.slice(-maxRecentEntries);

  // Extract decision history from gathered data entries
  const decisionEntries = gatheredData.entries
    .filter(e => e.type === 'decision')
    .slice(-maxRecentDecisions);

  const decisionHistory = decisionEntries.map(e => ({
    decision: e.content.summary,
    reasoning: (e.content.details?.fullReasoning as string) || '',
    outcome: e.content.details?.outcome as string | undefined,
    confidence: (e.content.details?.confidence as number) || 0,
    timestamp: e.timestamp,
  }));

  // Generate continuation instructions
  const continuationInstructions = generateContinuationInstructions(
    agentName,
    gatheredData
  );

  // Build the state without checksum first
  const stateWithoutChecksum: Omit<HandoffState, 'checksum'> = {
    version: HANDOFF_VERSION,
    agentName,
    goalId: gatheredData.goalId,
    preparedAt: new Date().toISOString(),
    goalProgress: {
      description: gatheredData.goal.description,
      status: gatheredData.goal.status,
      stepsCompleted: gatheredData.summary.totalSteps,
      successCriteria,
    },
    gatheredDataSummary: {
      totalEntries: gatheredData.entries.length,
      recentEntries,
      summary: gatheredData.summary,
    },
    decisionHistory,
    activeElements,
    continuationInstructions,
  };

  // Compute checksum over the data payload
  const checksum = computeChecksum(stateWithoutChecksum);

  return { ...stateWithoutChecksum, checksum };
}

/**
 * Validate a handoff state's checksum integrity.
 *
 * @param state - HandoffState to validate
 * @returns true if checksum is valid
 */
export function validateHandoffChecksum(state: HandoffState): boolean {
  const { checksum, ...rest } = state;
  const computed = computeChecksum(rest);
  return computed === checksum;
}

// =============================================================================
// Handoff Block Generation (#71)
// =============================================================================

/** Visual border for handoff blocks */
const HANDOFF_BORDER = '═'.repeat(60);
const HANDOFF_MARKER_START = '╔' + HANDOFF_BORDER + '╗';
const HANDOFF_MARKER_END = '╚' + HANDOFF_BORDER + '╝';
const HANDOFF_PAYLOAD_START = '--- HANDOFF PAYLOAD START ---';
const HANDOFF_PAYLOAD_END = '--- HANDOFF PAYLOAD END ---';

/**
 * Generate a copy-pasteable handoff block with human-readable summary
 * and machine-readable compressed payload.
 *
 * The block format:
 * ```
 * ╔════════...════╗
 * ║ AGENT HANDOFF — {agentName}
 * ║ Goal: {description}
 * ║ Status: {status} | Steps: {n} | Confidence: {avg}
 * ║
 * ║ Next Steps:
 * ║ {continuationInstructions}
 * ╚════════...════╝
 * --- HANDOFF PAYLOAD START ---
 * {base64-compressed-json}
 * --- HANDOFF PAYLOAD END ---
 * ```
 *
 * @param state - HandoffState to encode
 * @returns Formatted handoff block string
 */
export function generateHandoffBlock(state: HandoffState): string {
  logger.info('Generating handoff block', {
    agentName: state.agentName,
    goalId: state.goalId,
    recentEntries: state.gatheredDataSummary.recentEntries.length,
    totalEntries: state.gatheredDataSummary.totalEntries,
    decisionCount: state.decisionHistory.length,
  });

  const lines: string[] = [];

  // Human-readable header
  lines.push(HANDOFF_MARKER_START);
  lines.push(`║ AGENT HANDOFF — ${state.agentName}`);
  lines.push(`║ Goal: ${state.goalProgress.description.substring(0, 80)}`);
  lines.push(
    `║ Status: ${state.goalProgress.status} | ` +
    `Steps: ${state.goalProgress.stepsCompleted} | ` +
    `Confidence: ${state.gatheredDataSummary.summary.averageConfidence}`
  );
  lines.push('║');
  lines.push('║ Next Steps:');
  for (const line of state.continuationInstructions.split('\n').slice(0, 5)) {
    lines.push(`║   ${line}`);
  }
  lines.push(HANDOFF_MARKER_END);

  // Machine-readable payload
  lines.push(HANDOFF_PAYLOAD_START);
  lines.push(compressHandoffState(state));
  lines.push(HANDOFF_PAYLOAD_END);

  return lines.join('\n');
}

/**
 * Parse a handoff block and extract the HandoffState.
 *
 * @param text - Raw text containing a handoff block
 * @returns Parsed and validated HandoffState
 * @throws Error if block is malformed, payload is corrupted, or checksum fails
 */
export function parseHandoffBlock(text: string): HandoffState {
  // Extract payload between markers
  const startIdx = text.indexOf(HANDOFF_PAYLOAD_START);
  const endIdx = text.indexOf(HANDOFF_PAYLOAD_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Invalid handoff block: missing payload markers');
  }

  const payloadStart = startIdx + HANDOFF_PAYLOAD_START.length;
  const payload = text.substring(payloadStart, endIdx).trim();

  if (!payload) {
    throw new Error('Invalid handoff block: empty payload');
  }

  // Decompress and parse
  const state = decompressHandoffState(payload);

  // Validate integrity
  if (!validateHandoffChecksum(state)) {
    throw new Error('Invalid handoff block: integrity check failed');
  }

  // Version check
  if (!state.version) {
    throw new Error('Invalid handoff state: missing version');
  }

  return state;
}

// =============================================================================
// Compression Utilities
// =============================================================================

/**
 * Compress a HandoffState to a base64-encoded gzip string.
 * JSON → gzip → base64 for compact copy/paste.
 */
export function compressHandoffState(state: HandoffState): string {
  const startTime = performance.now();
  const json = JSON.stringify(state);
  const uncompressedBytes = Buffer.byteLength(json, 'utf-8');
  const compressed = gzipSync(Buffer.from(json, 'utf-8'));
  const compressedBytes = compressed.length;
  const compressionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;
  const compressionRatio = uncompressedBytes > 0
    ? Math.round((1 - compressedBytes / uncompressedBytes) * 10000) / 100
    : 0;

  logger.info('Handoff state compressed', {
    agentName: state.agentName,
    goalId: state.goalId,
    uncompressedBytes,
    compressedBytes,
    compressionRatio: `${compressionRatio}%`,
    compressionTimeMs,
  });

  const warnThreshold = getHandoffWarnPayloadBytes();
  if (compressedBytes > warnThreshold) {
    logger.warn('Handoff payload exceeds size threshold', {
      agentName: state.agentName,
      goalId: state.goalId,
      compressedBytes,
      warnThresholdBytes: warnThreshold,
    });
  }

  return compressed.toString('base64');
}

/**
 * Decompress a base64-encoded gzip string back to HandoffState.
 * base64 → gunzip → JSON.parse
 */
export function decompressHandoffState(encoded: string): HandoffState {
  try {
    const compressed = Buffer.from(encoded, 'base64');
    const decompressed = gunzipSync(compressed);
    const json = decompressed.toString('utf-8');
    const state = JSON.parse(json) as HandoffState;
    return state;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error('Handoff payload decompression failed', { detail });
    throw new Error('Invalid handoff block: payload could not be restored');
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Compute SHA-256 checksum of a data payload.
 */
function computeChecksum(data: Record<string, unknown>): string {
  const json = JSON.stringify(data, Object.keys(data).sort((a, b) => a.localeCompare(b)));
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Generate human-readable continuation instructions from gathered data.
 */
function generateContinuationInstructions(
  agentName: string,
  data: GatheredData
): string {
  const lines: string[] = [];

  lines.push(`Resume execution of agent '${agentName}'.`);

  if (data.goal.status === 'in_progress') {
    lines.push(`Goal is in progress: ${data.goal.description}`);
    lines.push(`${data.summary.totalSteps} steps completed so far.`);

    if (data.summary.failedSteps > 0) {
      lines.push(`Note: ${data.summary.failedSteps} step(s) failed — review before continuing.`);
    }
  } else if (data.goal.status === 'completed') {
    lines.push(`Goal was completed. Review results and close out.`);
  } else if (data.goal.status === 'failed') {
    lines.push(`Goal failed. Investigate and decide whether to retry.`);
  }

  // Recent decisions for context
  const recentDecisions = data.entries
    .filter(e => e.type === 'decision')
    .slice(-3);

  if (recentDecisions.length > 0) {
    lines.push('');
    lines.push('Recent steps:');
    for (const d of recentDecisions) {
      const outcome = d.content.details?.outcome || 'unknown';
      lines.push(`  - [${outcome}] ${d.content.summary.substring(0, 80)}`);
    }
  }

  return lines.join('\n');
}
