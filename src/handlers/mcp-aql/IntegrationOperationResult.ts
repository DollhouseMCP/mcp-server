/** MCP integration adapters return JSON text even for policy denials. */
export function integrationOperationError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('content' in value) || !Array.isArray(value.content)) return undefined;
  const text = value.content.find((item: unknown) => item && typeof item === 'object' && 'type' in item && item.type === 'text');
  if (!text || typeof text.text !== 'string') return undefined;
  let result: unknown;
  try {
    result = JSON.parse(text.text);
  } catch {
    // A presentation detector must not turn a completed call into a retryable failure.
    return undefined;
  }
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== false) return undefined;
  const error = 'error' in result ? result.error : undefined;
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'Integration operation denied or failed';
}
