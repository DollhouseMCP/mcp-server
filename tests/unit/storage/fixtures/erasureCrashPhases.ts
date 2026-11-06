/** Bounded, failure-only evidence from the already-owned crash child. */
export class ErasureCrashPhases {
  private readonly phases: { phase: string; elapsedMs: number }[] = [];
  constructor(private readonly childStartedEpochMs: number) {}

  observe(message: unknown): void {
    if (!message || typeof message !== 'object' || this.phases.length >= 5) return;
    const value = message as { type?: unknown; phase?: unknown; at?: unknown };
    if (value.type === 'erasure-profile' && typeof value.phase === 'string' &&
      ['script-entry', 'owners-imported', 'dependencies-imported', 'erase-start', 'barrier'].includes(value.phase) &&
      typeof value.at === 'number' && Number.isFinite(value.at)) {
      this.phases.push({ phase: value.phase, elapsedMs: value.at - this.childStartedEpochMs });
    }
  }

  report(failed: boolean, explicitlyRequested: boolean): { childPhases?: { phase: string; elapsedMs: number }[] } {
    return failed || explicitlyRequested ? { childPhases: [...this.phases] } : {};
  }
}
