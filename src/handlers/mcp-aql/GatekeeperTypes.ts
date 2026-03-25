/**
 * Gatekeeper Type Definitions
 *
 * Type definitions for the Gatekeeper Policy Engine.
 * These types define the permission system, policy structures,
 * and enforcement results for MCP-AQL access control.
 */

import type { CRUDEndpoint } from './OperationRouter.js';

/**
 * Permission levels for operation access control.
 * These define how operations are approved or denied.
 */
export enum PermissionLevel {
  /** Always allowed, no confirmation needed */
  AUTO_APPROVE = 'AUTO_APPROVE',
  /** Confirm THIS instance only, ask again next time */
  CONFIRM_SINGLE_USE = 'CONFIRM_SINGLE_USE',
  /** Confirm once, auto-approve for rest of session */
  CONFIRM_SESSION = 'CONFIRM_SESSION',
  /** Never allowed (blocked by policy) */
  DENY = 'DENY',
}

/**
 * Verification strictness levels.
 * Define how aggressively the Gatekeeper challenges operations.
 */
export enum VerificationStrictness {
  /** Only DANGER_ZONE operations require verification */
  MINIMAL = 'MINIMAL',
  /** DANGER_ZONE + policy violations (default) */
  STANDARD = 'STANDARD',
  /** Above + DELETE operations */
  ELEVATED = 'ELEVATED',
  /** All mutations require verification */
  MAXIMUM = 'MAXIMUM',
}

/**
 * Gatekeeper error codes for rich LLM error responses.
 * Each code maps to a specific failure scenario with actionable guidance.
 */
export enum GatekeeperErrorCode {
  /** Operation not found in the routing table */
  UNKNOWN_OPERATION = 'UNKNOWN_OPERATION',
  /** Operation called via wrong CRUD endpoint */
  ENDPOINT_MISMATCH = 'ENDPOINT_MISMATCH',
  /** Active element's policy blocks this operation */
  ELEMENT_POLICY_VIOLATION = 'ELEMENT_POLICY_VIOLATION',
  /** Operation not allowed for this element type */
  SCOPE_RESTRICTION = 'SCOPE_RESTRICTION',
  /** Denied by default operation policy */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** User confirmation required before proceeding */
  CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED',
  /** High-risk operation requires verification code */
  VERIFICATION_REQUIRED = 'VERIFICATION_REQUIRED',
  /** Wrong verification code entered */
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  /** User did not respond to verification prompt */
  VERIFICATION_TIMEOUT = 'VERIFICATION_TIMEOUT',
  /** Destructive pattern detected, operation blocked */
  DANGER_ZONE_BLOCKED = 'DANGER_ZONE_BLOCKED',
  /** Session is invalid or expired */
  SESSION_INVALID = 'SESSION_INVALID',
}

/**
 * Result of a Gatekeeper policy check.
 * Indicates whether an operation is allowed and what actions are needed.
 */
export interface GatekeeperDecision {
  /** Whether the operation is allowed to proceed */
  allowed: boolean;
  /** Permission level determined for this operation */
  permissionLevel: PermissionLevel;
  /** Error code if the operation is denied */
  errorCode?: GatekeeperErrorCode;
  /** Human-readable reason for the decision */
  reason: string;
  /** Actionable suggestion for the LLM on what to do next */
  suggestion?: string;
  /** Whether a confirmation is pending from the user */
  confirmationPending?: boolean;
  /** The policy source that determined this decision */
  policySource?: 'operation_default' | 'element_policy' | 'safety_tier' | 'session_confirmation';
}

/**
 * Confirmation record for session-scoped approvals.
 * Tracks which operations have been confirmed for this session.
 */
export interface ConfirmationRecord {
  /** The operation that was confirmed */
  operation: string;
  /** When the confirmation was granted */
  confirmedAt: string;
  /** The permission level that was confirmed */
  permissionLevel: PermissionLevel.CONFIRM_SESSION | PermissionLevel.CONFIRM_SINGLE_USE;
  /** Number of times this confirmation has been used */
  useCount: number;
  /** Optional element type scope for the confirmation */
  elementType?: string;
}

/**
 * Element-level Gatekeeper policy.
 * Allows ANY DollhouseMCP element to define access control policies.
 * These are stored in the element's metadata YAML front matter.
 */
export interface ElementGatekeeperPolicy {
  /** Operations auto-approved when this element is active */
  allow?: string[];
  /** Operations requiring confirmation when this element is active */
  confirm?: string[];
  /** Operations blocked when this element is active */
  deny?: string[];
  /** Restrict operations to specific element types */
  scopeRestrictions?: {
    /** Allow operations only on these element types */
    allowedTypes?: string[];
    /** Block operations on these element types */
    blockedTypes?: string[];
  };
  /** Advisory restrictions for external tools (CLI permission delegation) */
  externalRestrictions?: {
    /** Description of external restrictions */
    description: string;
    /** Patterns to deny for external tool operations */
    denyPatterns?: string[];
    /** Patterns requiring human approval before execution (Issue #1660).
     *  Evaluated after denyPatterns, before allowPatterns.
     *  Deny always takes precedence over confirm. */
    confirmPatterns?: string[];
    /** When defined, only tools matching at least one pattern are permitted (allowlist mode).
     *  Deny always takes precedence over allow. Across elements, allows are unioned. */
    allowPatterns?: string[];
    /** Approval policy for CLI tool operations (Issue #625 Phase 3) */
    approvalPolicy?: CliApprovalPolicy;
  };
}

// ── CLI Approval Types (Issue #625 Phase 3) ───────────────────────

/**
 * Scope for CLI approval records.
 * - 'single': consumed after one use
 * - 'tool_session': all uses of that tool for the session
 */
export type CliApprovalScope = 'single' | 'tool_session';

/**
 * Approval policy for CLI tool operations.
 * Configures which risk levels need human approval.
 */
export interface CliApprovalPolicy {
  /** Risk levels that require human approval before proceeding */
  requireApproval?: ('moderate' | 'dangerous')[];
  /** Default scope for approvals (default: 'single') */
  defaultScope?: CliApprovalScope;
  /** Time-to-live for pending approvals in seconds (30-3600, default: 300) */
  ttlSeconds?: number;
}

/**
 * Record of a CLI tool approval request.
 * Created when permission_prompt encounters a tool that requires approval.
 */
export interface CliApprovalRecord {
  /** Unique request identifier (format: cli-<UUIDv4>) */
  requestId: string;
  /** The tool that was requested */
  toolName: string;
  /** The tool input parameters */
  toolInput: Record<string, unknown>;
  /** Risk level from classification */
  riskLevel: string;
  /** Numeric risk score (0-100) */
  riskScore: number;
  /** Whether the operation is irreversible */
  irreversible: boolean;
  /** When the request was created */
  requestedAt: string;
  /** When the request was approved (undefined if pending) */
  approvedAt?: string;
  /** Whether this approval has been consumed */
  consumed: boolean;
  /** Approval scope */
  scope: CliApprovalScope;
  /** Reason the tool was denied (pending approval) */
  denyReason: string;
  /** Which policy source triggered the approval requirement */
  policySource?: string;
  /** Per-record TTL in milliseconds (overrides default 300s) */
  ttlMs?: number;
}

/**
 * Risk assessment for a CLI tool call.
 * Provides a numeric score and irreversibility indicator.
 */
export interface RiskAssessment {
  /** Numeric risk score (0-100) */
  score: number;
  /** Whether the operation is irreversible */
  irreversible: boolean;
  /** Factors that contributed to the risk score */
  factors: string[];
}

/**
 * Endpoint permissions for CRUD endpoints.
 * Defines the security characteristics of each endpoint.
 */
export interface EndpointPermissions {
  /** Whether the endpoint only reads data */
  readOnly: boolean;
  /** Whether the endpoint can perform destructive operations */
  destructive: boolean;
}

/**
 * Audit log entry for Gatekeeper decisions.
 * Logged to SecurityMonitor for security analysis.
 */
export interface GatekeeperAuditEntry {
  /** Timestamp of the decision */
  timestamp: string;
  /** Session ID that made the request */
  sessionId: string;
  /** Operation that was checked */
  operation: string;
  /** CRUD endpoint used */
  endpoint: CRUDEndpoint;
  /** Element type if applicable */
  elementType?: string;
  /** The decision made */
  decision: GatekeeperDecision;
  /** Client information if available */
  clientInfo?: {
    name: string;
    version: string;
  };
}

/**
 * Operation policy mapping entry.
 * Defines the default permission level for an operation.
 */
export interface OperationPolicy {
  /** Default permission level for this operation */
  defaultLevel: PermissionLevel;
  /** Human-readable description of why this level is assigned */
  rationale: string;
  /** Whether this operation can be elevated by active elements */
  canBeElevated?: boolean;
}
