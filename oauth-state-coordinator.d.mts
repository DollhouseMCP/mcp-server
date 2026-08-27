export function withOAuthStateLockSync<T>(stateFile: string, operation: () => T): T;
export function withOAuthStateLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T>;
export function writeFileAtomicallySync(filePath: string, serializedState: string, mode?: number): void;
