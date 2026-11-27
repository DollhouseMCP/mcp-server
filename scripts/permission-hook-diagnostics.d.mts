export interface PermissionHookDiagnosticRecord {
  timestamp: string;
  platform: string;
  stage: string;
  outcome: string;
  toolName?: string;
  elapsedMs?: number;
  attempt?: number;
  timeoutSeconds?: number;
  curlExit?: number;
}

export function getPermissionDiagnosticPath(runDir: string): string;
export function appendPermissionDiagnostic(path: string, diagnostic: unknown, limit?: number): Promise<void>;
export function readLatestPermissionDiagnostic(path: string): Promise<PermissionHookDiagnosticRecord | null>;
