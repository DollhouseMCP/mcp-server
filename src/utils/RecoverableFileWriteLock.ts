import { withRecoverableFileWriteLock as withLocalFileLock } from '../../scripts/recoverable-file-write-lock.mjs';
import { SecurityMonitor } from '../security/securityMonitor.js';

export function withRecoverableFileWriteLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  return withLocalFileLock(lockPath, operation, timeoutMs, (pid) => {
    SecurityMonitor.logSecurityEvent({
      type: 'DANGER_ZONE_OPERATION',
      severity: 'HIGH',
      source: 'RecoverableFileWriteLock',
      details: 'Reclaimed the file write lock of a dead local process',
      additionalData: { pid },
    });
  });
}
