export function withRecoverableFileWriteLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs?: number,
  onReclaimed?: (pid: number) => void,
): Promise<T>;
