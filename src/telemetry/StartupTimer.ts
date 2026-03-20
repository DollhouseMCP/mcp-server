/**
 * StartupTimer — Lightweight startup phase timing instrumentation.
 *
 * Tracks per-phase durations during server initialization, split into
 * critical (pre-connect) and deferred (post-connect) categories.
 *
 * Registered as a DI singleton so BuildInfoService can expose timings
 * via `get_build_info`.
 *
 * Issue #706: MCP Startup Race Hardening
 */

export interface PhaseEntry {
  name: string;
  critical: boolean;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
}

export interface StartupReport {
  phases: Array<{
    name: string;
    critical: boolean;
    durationMs: number;
  }>;
  criticalPathMs: number;
  deferredMs: number;
  totalMs: number;
  connectAtMs: number | null;
}

export class StartupTimer {
  private phases = new Map<string, PhaseEntry>();
  private originMs: number;
  private connectAtMs: number | null = null;

  constructor() {
    this.originMs = Date.now();
  }

  /**
   * Begin timing a named phase.
   * @param name   Unique phase identifier (e.g. "config_manager")
   * @param critical  true = pre-connect critical path, false = deferred
   */
  startPhase(name: string, critical: boolean): void {
    this.phases.set(name, {
      name,
      critical,
      startMs: Date.now(),
      endMs: null,
      durationMs: null,
    });
  }

  /**
   * End a previously started phase. Idempotent — second call is a no-op.
   */
  endPhase(name: string): void {
    const phase = this.phases.get(name);
    if (!phase || phase.endMs !== null) return;
    phase.endMs = Date.now();
    phase.durationMs = phase.endMs - phase.startMs;
  }

  /**
   * Record the instant MCP `server.connect()` completes.
   */
  markConnect(): void {
    this.connectAtMs = Date.now();
  }

  /**
   * Produce the final report. Un-ended phases are auto-closed.
   */
  getReport(): StartupReport {
    const now = Date.now();
    const completed: Array<{ name: string; critical: boolean; durationMs: number }> = [];

    for (const phase of this.phases.values()) {
      const duration = phase.durationMs ?? (now - phase.startMs);
      completed.push({ name: phase.name, critical: phase.critical, durationMs: duration });
    }

    const criticalPathMs = completed
      .filter(p => p.critical)
      .reduce((sum, p) => sum + p.durationMs, 0);

    const deferredMs = completed
      .filter(p => !p.critical)
      .reduce((sum, p) => sum + p.durationMs, 0);

    return {
      phases: completed,
      criticalPathMs,
      deferredMs,
      totalMs: now - this.originMs,
      connectAtMs: this.connectAtMs ? this.connectAtMs - this.originMs : null,
    };
  }
}
