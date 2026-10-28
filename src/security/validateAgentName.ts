import { BlockStateValidationError } from './BlockStateValidationError.js';

/**
 * Validates agent name input
 * @throws Error if agent name is invalid
 */
export function validateAgentName(agentName: string, operation: string): void {
  if (!agentName || typeof agentName !== 'string') {
    throw new BlockStateValidationError(`${operation}: Agent name is required`);
  }
  const trimmed = agentName.trim();
  if (trimmed.length === 0) {
    throw new BlockStateValidationError(`${operation}: Agent name cannot be empty or whitespace`);
  }
  // Prevent path traversal and special characters that could cause issues
  // eslint-disable-next-line no-control-regex -- Intentionally checking for control chars as security measure
  if (/[<>:"/\\|?*\x00-\x1f]/.test(trimmed)) {
    throw new BlockStateValidationError(`${operation}: Agent name contains invalid characters`);
  }
  if (trimmed.length > 256) {
    throw new BlockStateValidationError(`${operation}: Agent name exceeds maximum length of 256 characters`);
  }
}
