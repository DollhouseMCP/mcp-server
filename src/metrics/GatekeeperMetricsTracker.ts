/**
 * Lightweight in-memory accumulator for Gatekeeper policy enforcement metrics.
 *
 * Records allowed/denied/confirmation-pending decisions, policy source
 * distribution, and permission level usage. The companion
 * GatekeeperMetricsCollector reads from this tracker each collection cycle.
 */

export interface GatekeeperDecisionRecord {
  allowed: boolean;
  permissionLevel: string;
  policySource?: string;
  confirmationPending?: boolean;
}

export interface GatekeeperMetrics {
  totalDecisions: number;
  allowed: number;
  denied: number;
  confirmationsPending: number;
  byPolicySource: Map<string, number>;
  byPermissionLevel: Map<string, number>;
}

export class GatekeeperMetricsTracker {
  private totalDecisions = 0;
  private allowed = 0;
  private denied = 0;
  private confirmationsPending = 0;
  private readonly byPolicySource = new Map<string, number>();
  private readonly byPermissionLevel = new Map<string, number>();

  record(decision: GatekeeperDecisionRecord): void {
    this.totalDecisions++;

    if (decision.allowed) {
      this.allowed++;
    } else {
      this.denied++;
    }

    if (decision.confirmationPending) {
      this.confirmationsPending++;
    }

    const source = decision.policySource ?? 'unknown';
    this.byPolicySource.set(source, (this.byPolicySource.get(source) ?? 0) + 1);

    const level = decision.permissionLevel;
    this.byPermissionLevel.set(level, (this.byPermissionLevel.get(level) ?? 0) + 1);
  }

  getMetrics(): GatekeeperMetrics {
    return {
      totalDecisions: this.totalDecisions,
      allowed: this.allowed,
      denied: this.denied,
      confirmationsPending: this.confirmationsPending,
      byPolicySource: new Map(this.byPolicySource),
      byPermissionLevel: new Map(this.byPermissionLevel),
    };
  }
}
