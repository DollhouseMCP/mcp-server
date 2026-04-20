export interface CurrentConsoleSessionIdentity {
  displayName: string | null;
  authoritative: boolean;
  role: 'leader' | 'follower';
  kind: 'mcp' | 'console';
  color: string | null;
  serverVersion: string;
  consoleProtocolVersion: number;
}

let currentConsoleSessionIdentity: CurrentConsoleSessionIdentity | null = null;

export function setCurrentConsoleSessionIdentity(identity: CurrentConsoleSessionIdentity): void {
  currentConsoleSessionIdentity = { ...identity };
}

export function getCurrentConsoleSessionIdentity(): CurrentConsoleSessionIdentity | null {
  return currentConsoleSessionIdentity ? { ...currentConsoleSessionIdentity } : null;
}

export function clearCurrentConsoleSessionIdentity(): void {
  currentConsoleSessionIdentity = null;
}
