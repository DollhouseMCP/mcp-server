/**
 * Configuration Scanner - Walks configuration files (JSON/YAML/.env) and flags
 * insecure defaults. Rules are intentionally conservative to avoid false
 * positives while still catching common deployment risks called out in the
 * production readiness review.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../../utils/logger.js';
import yaml from 'js-yaml';
import type { SecurityScanner, SecurityFinding, ScanContext, SeverityLevel } from '../types.js';

interface ConfigurationScannerConfig {
  enabled: boolean;
  checkFiles: string[];
}

type ConfigObject = Record<string, any>;

const SUSPICIOUS_PATTERNS = [
  {
    match: (line: string) => /DOLLHOUSE_TELEMETRY\s*=\s*true/i.test(line),
    ruleId: 'CONFIG-TELEMETRY-OPT-IN',
    severity: 'medium' as SeverityLevel,
    message: 'Telemetry should remain opt-in by default. Remove DOLLHOUSE_TELEMETRY=true from shared configs.',
    remediation: 'Set DOLLHOUSE_TELEMETRY=false or document why opt-in behaviour is overridden.'
  }
];

const CONFIG_RULES = [
  {
    ruleId: 'CONFIG-BULK-PREVIEW',
    path: ['sync', 'bulk', 'require_preview'],
    insecureValue: false,
    severity: 'medium' as SeverityLevel,
    message: 'Bulk sync preview is disabled. Users could upload/download without review.',
    remediation: 'Set sync.bulk.require_preview to true to require confirmation before bulk operations.'
  },
  {
    ruleId: 'CONFIG-SECRET-SCANNING',
    path: ['sync', 'privacy', 'scan_for_secrets'],
    insecureValue: false,
    severity: 'high' as SeverityLevel,
    message: 'Secret scanning is disabled in sync. This may leak credentials when uploading.',
    remediation: 'Set sync.privacy.scan_for_secrets to true.'
  },
  {
    ruleId: 'CONFIG-TELEMETRY-DEFAULT',
    path: ['elements', 'enhanced_index', 'telemetry', 'enabled'],
    insecureValue: true,
    severity: 'medium' as SeverityLevel,
    message: 'Enhanced index telemetry is enabled by default. It should require explicit opt-in.',
    remediation: 'Set elements.enhanced_index.telemetry.enabled to false unless the deployment has obtained consent.'
  }
];

export class ConfigurationScanner implements SecurityScanner {
  name = 'ConfigurationScanner';
  private config: ConfigurationScannerConfig;

  constructor(config: ConfigurationScannerConfig) {
    this.config = config;
  }

  async scan(context: ScanContext): Promise<SecurityFinding[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const findings: SecurityFinding[] = [];
    try {
      const files = await this.collectCandidateFiles(context.projectRoot);
      for (const filePath of files) {
        const fileFindings = await this.evaluateFile(filePath);
        findings.push(...fileFindings);
      }
    } catch (error) {
      logger.error('[ConfigurationScanner] Failed to scan configuration', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return findings;
  }

  isEnabled(): boolean {
    return Boolean(this.config?.enabled);
  }

  private async collectCandidateFiles(projectRoot: string): Promise<string[]> {
    const files: string[] = [];
    const excludeDirs = new Set(['node_modules', 'dist', '.git']);

    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excludeDirs.has(entry.name)) continue;
          await walk(fullPath);
        } else if (this.matchesPatterns(entry.name)) {
          files.push(fullPath);
        }
      }
    };

    await walk(projectRoot);
    return files;
  }

  private matchesPatterns(fileName: string): boolean {
    if (!this.config.checkFiles || this.config.checkFiles.length === 0) {
      return true;
    }
    return this.config.checkFiles.some(pattern => {
      const normalizedPattern = pattern.trim().toLowerCase();
      if (normalizedPattern.startsWith('*')) {
        return fileName.toLowerCase().endsWith(normalizedPattern.slice(1));
      }
      return fileName.toLowerCase() === normalizedPattern;
    });
  }

  private async evaluateFile(filePath: string): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];
    const extension = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath);

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      if (baseName.startsWith('.env')) {
        findings.push(...this.evaluateEnvFile(content, filePath));
      } else if (extension === '.json') {
        const parsed = JSON.parse(content) as ConfigObject;
        findings.push(...this.evaluateConfigObject(parsed, filePath));
      } else if (extension === '.yml' || extension === '.yaml') {
        // Use FAILSAFE_SCHEMA for safe YAML parsing (no arbitrary object instantiation)
        const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA }) as ConfigObject;
        if (parsed && typeof parsed === 'object') {
          findings.push(...this.evaluateConfigObject(parsed, filePath));
        }
      }
    } catch (error) {
      logger.debug('[ConfigurationScanner] Failed to parse config file', {
        file: filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return findings;
  }

  private evaluateEnvFile(content: string, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split(/\r?\n/);
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (lines.some(line => pattern.match(line))) {
        findings.push({
          ruleId: pattern.ruleId,
          severity: pattern.severity,
          message: pattern.message,
          file: path.relative(process.cwd(), filePath),
          remediation: pattern.remediation,
          confidence: 'high'
        });
      }
    }
    return findings;
  }

  private evaluateConfigObject(config: ConfigObject, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    for (const rule of CONFIG_RULES) {
      const value = this.getValue(config, rule.path);
      if (value === undefined) continue;

      // FIX: FAILSAFE_SCHEMA parses booleans as strings ("true"/"false")
      // Normalize for comparison: convert string booleans to actual booleans
      const normalizedValue = this.normalizeValue(value);

      if (normalizedValue === rule.insecureValue) {
        findings.push({
          ruleId: rule.ruleId,
          severity: rule.severity,
          message: rule.message,
          file: path.relative(process.cwd(), filePath),
          remediation: rule.remediation,
          confidence: 'medium'
        });
      }
    }
    return findings;
  }

  /**
   * Normalize YAML FAILSAFE_SCHEMA values for comparison.
   * FAILSAFE_SCHEMA parses everything as strings, so "false" -> false, "true" -> true.
   */
  private normalizeValue(value: any): any {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      // Try to parse as number
      const num = Number(value);
      if (!isNaN(num) && value.trim() !== '') return num;
    }
    return value;
  }

  private getValue(config: ConfigObject, pathSegments: string[]): any {
    return pathSegments.reduce((value, key) => {
      if (value && typeof value === 'object' && key in value) {
        return value[key];
      }
      return undefined;
    }, config as any);
  }
}
