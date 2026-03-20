/**
 * Telemetry Module
 *
 * Privacy-first operational analytics for DollhouseMCP
 *
 * Exports:
 * - Type definitions for telemetry events and configuration
 * - OperationalTelemetry class for telemetry initialization and management
 */

export * from './types.js';
export { OperationalTelemetry } from './OperationalTelemetry.js';
export { StartupTimer } from './StartupTimer.js';
export type { PhaseEntry, StartupReport } from './StartupTimer.js';
