import type { HandlerRegistry } from './MCPAQLHandler.js';

export class ConfigDispatcher {
  constructor(private readonly handlers: HandlerRegistry) {}

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'manage':
        return this.manageConfig(params);
      case 'getBuildInfo':
        return this.getBuildInfo();
      case 'getCacheBudgetReport':
        return this.getCacheBudgetReport();
      default:
        throw new Error(`Unknown Config method: ${method}`);
    }
  }

  private manageConfig(params: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.configHandler;
    if (!handler) {
      throw new Error('Config operations not available: ConfigHandler not configured');
    }
    return handler.handleConfigOperation({
      action: params.action as 'get' | 'set' | 'reset' | 'export' | 'import' | 'wizard',
      setting: params.setting as string | undefined,
      value: params.value,
      section: params.section as string | undefined,
      format: params.format as 'yaml' | 'json' | undefined,
      data: params.data as string | undefined,
    });
  }

  private async getBuildInfo(): Promise<unknown> {
    const service = this.handlers.buildInfoService;
    if (!service) {
      throw new Error('BuildInfo operations not available: BuildInfoService not configured');
    }
    const info = await service.getBuildInfo();
    return {
      content: [{
        type: 'text',
        text: service.formatBuildInfo(info)
      }]
    };
  }

  private getCacheBudgetReport(): unknown {
    const budget = this.handlers.cacheMemoryBudget;
    if (!budget) {
      throw new Error('Cache budget not available: CacheMemoryBudget not configured');
    }
    return {
      content: [{
        type: 'text',
        text: this.formatCacheBudgetReport(budget.getReport())
      }]
    };
  }

  private formatCacheBudgetReport(report: {
    budgetMB: number;
    totalMemoryMB: number;
    utilizationPercent: number;
    caches: Array<{
      name: string;
      entries: number;
      memoryMB: number;
      hitRate: number;
      lastActivityMs: number;
    }>;
  }): string {
    const lines = [
      '# Cache Memory Budget Report',
      '',
      `**Budget:** ${report.budgetMB} MB`,
      `**Used:** ${report.totalMemoryMB} MB (${report.utilizationPercent}%)`,
      `**Registered Caches:** ${report.caches.length}`,
      '',
    ];
    if (report.caches.length === 0) {
      return [...lines, '_No caches registered._'].join('\n');
    }
    return [...lines, ...this.formatCacheRows(report.caches)].join('\n');
  }

  private formatCacheRows(caches: Array<{
    name: string;
    entries: number;
    memoryMB: number;
    hitRate: number;
    lastActivityMs: number;
  }>): string[] {
    return [
      '| Cache | Entries | Memory (MB) | Hit Rate | Last Activity |',
      '|-------|---------|-------------|----------|---------------|',
      ...caches.map(c => {
        const activity = c.lastActivityMs > 0
          ? `${((Date.now() - c.lastActivityMs) / 1000).toFixed(0)}s ago`
          : 'never';
        return `| ${c.name} | ${c.entries} | ${c.memoryMB} | ${(c.hitRate * 100).toFixed(1)}% | ${activity} |`;
      }),
    ];
  }
}
