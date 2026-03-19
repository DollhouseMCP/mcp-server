/**
 * Standardized CRUD operation response types
 *
 * This module provides consistent error handling for all CRUD operations
 * across element managers and handlers. Instead of throwing exceptions,
 * operations return structured responses that indicate success/failure.
 *
 * Design Principles:
 * - Return responses, don't throw exceptions for expected errors
 * - Provide detailed error context for debugging
 * - Include error codes for programmatic handling
 * - Maintain backward compatibility for success paths
 */

/**
 * Standard error codes for CRUD operations
 */
export enum CrudErrorCode {
  /** Element not found when attempting read/update/delete */
  NOT_FOUND = 'NOT_FOUND',

  /** Element already exists when attempting create */
  ALREADY_EXISTS = 'ALREADY_EXISTS',

  /** Validation failed for element data */
  VALIDATION_FAILED = 'VALIDATION_FAILED',

  /** Attempted to modify read-only field */
  READ_ONLY_FIELD = 'READ_ONLY_FIELD',

  /** Referenced element does not exist */
  INVALID_REFERENCE = 'INVALID_REFERENCE',

  /** Circular dependency detected */
  CIRCULAR_DEPENDENCY = 'CIRCULAR_DEPENDENCY',

  /** Operation failed for other reasons */
  OPERATION_FAILED = 'OPERATION_FAILED',

  /** Invalid input parameters */
  INVALID_INPUT = 'INVALID_INPUT',

  /** Permission denied */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
}

/**
 * Standardized response for CRUD operations
 *
 * @template T - Type of data returned on success
 */
export interface CrudResponse<T = any> {
  /** Whether the operation succeeded */
  success: boolean;

  /** Data returned on success (undefined on failure) */
  data?: T;

  /** Human-readable error message (only on failure) */
  error?: string;

  /** Machine-readable error code (only on failure) */
  errorCode?: CrudErrorCode;

  /** Additional context about the error */
  details?: Record<string, any>;
}

/**
 * Helper to create a successful response
 */
export function successResponse<T>(data: T): CrudResponse<T> {
  return {
    success: true,
    data,
  };
}

/**
 * Helper to create an error response
 */
export function errorResponse(
  error: string,
  errorCode: CrudErrorCode,
  details?: Record<string, any>
): CrudResponse<never> {
  return {
    success: false,
    error,
    errorCode,
    details,
  };
}

/**
 * Helper to wrap exceptions as error responses
 */
export function exceptionToErrorResponse(
  error: unknown,
  context: Record<string, any> = {}
): CrudResponse<never> {
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(
    `Operation failed: ${message}`,
    CrudErrorCode.OPERATION_FAILED,
    { ...context, originalError: message }
  );
}
