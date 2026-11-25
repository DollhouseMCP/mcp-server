export function freshFixtureHome(runDirectory: string): string;
export function withMigrationHome<T>(run: (home: string) => Promise<T>): Promise<T>;
export function appHome(runDirectory: string, options?: { fresh?: boolean }): string;
