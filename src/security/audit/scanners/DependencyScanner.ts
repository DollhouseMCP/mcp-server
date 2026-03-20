/**
 * Dependency Scanner - Detects vulnerable or disallowed dependencies based on
 * locally available metadata (package-lock.json) without requiring network
 * access. This provides deterministic findings in CI while still encouraging
 * upgrades away from well-known CVEs.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../../utils/logger.js';
import type { SecurityScanner, SecurityFinding, ScanContext, SeverityLevel } from '../types.js';

interface DependencyInfo {
  name: string;
  version: string;
  license?: string;
}

interface DependencyScannerConfig {
  enabled: boolean;
  severityThreshold: SeverityLevel;
  checkLicenses: boolean;
  allowedLicenses?: string[];
}

interface KnownVulnerability {
  id: string;
  package: string;
  fixedVersion: string;
  severity: SeverityLevel;
  description: string;
  remediation: string;
  cve?: string;
}

const KNOWN_VULNERABILITIES: KnownVulnerability[] = [
  {
    id: 'DEPENDENCY-LODASH-2021-23337',
    package: 'lodash',
    fixedVersion: '4.17.21',
    severity: 'high',
    description: 'Lodash versions prior to 4.17.21 are vulnerable to prototype pollution (GHSA-p6mc-m468-83gw).',
    remediation: 'Upgrade lodash to >= 4.17.21.',
    cve: 'CVE-2021-23337'
  },
  {
    id: 'DEPENDENCY-MINIMIST-2020-7598',
    package: 'minimist',
    fixedVersion: '1.2.6',
    severity: 'high',
    description: 'Minimist < 1.2.6 is vulnerable to prototype pollution (GHSA-vh95-rmgr-6w4m).',
    remediation: 'Upgrade minimist to >= 1.2.6.',
    cve: 'CVE-2020-7598'
  },
  {
    id: 'DEPENDENCY-XML2JS-2022-3517',
    package: 'xml2js',
    fixedVersion: '0.5.0',
    severity: 'medium',
    description: 'xml2js versions prior to 0.5.0 may lead to DoS via entity expansion.',
    remediation: 'Upgrade xml2js to >= 0.5.0.'
  }
];

export class DependencyScanner implements SecurityScanner {
  name = 'DependencyScanner';
  private config: DependencyScannerConfig;
  private severityThreshold: SeverityLevel;

  constructor(config: DependencyScannerConfig) {
    this.config = config;
    this.severityThreshold = config.severityThreshold ?? 'low';
  }

  async scan(context: ScanContext): Promise<SecurityFinding[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const findings: SecurityFinding[] = [];
    try {
      const dependencies = await this.loadDependencies(context.projectRoot);
      if (dependencies.length === 0) {
        logger.debug('[DependencyScanner] No dependencies found to scan');
        return findings;
      }

      for (const dep of dependencies) {
        findings.push(...this.evaluateVulnerabilities(dep));
        findings.push(...this.evaluateLicenses(dep));
      }
    } catch (error) {
      logger.error('[DependencyScanner] Failed to scan dependencies', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return findings;
  }

  isEnabled(): boolean {
    return Boolean(this.config?.enabled);
  }

  private async loadDependencies(projectRoot: string): Promise<DependencyInfo[]> {
    const lockPath = path.join(projectRoot, 'package-lock.json');
    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      const parsed = JSON.parse(content);
      const deps = new Map<string, DependencyInfo>();

      if (parsed.dependencies) {
        this.collectFromDependencies(parsed.dependencies, deps);
      }

      if (parsed.packages) {
        for (const [pkgPath, pkgInfo] of Object.entries<any>(parsed.packages)) {
          if (!pkgInfo || !pkgInfo.version) {
            continue;
          }

          const name = pkgInfo.name || this.inferNameFromPath(pkgPath);
          if (!name) {
            continue;
          }

          if (!deps.has(name)) {
            deps.set(name, {
              name,
              version: pkgInfo.version,
              license: pkgInfo.license || pkgInfo.licenses
            });
          }
        }
      }

      return Array.from(deps.values());
    } catch (error) {
      logger.warn('[DependencyScanner] Unable to read package-lock.json', {
        path: lockPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private collectFromDependencies(deps: Record<string, any>, map: Map<string, DependencyInfo>): void {
    for (const [name, info] of Object.entries<any>(deps)) {
      if (!info || !info.version) {
        continue;
      }

      if (!map.has(name)) {
        map.set(name, {
          name,
          version: info.version,
          license: info.license || info.licenses
        });
      }

      if (info.dependencies) {
        this.collectFromDependencies(info.dependencies, map);
      }
    }
  }

  private inferNameFromPath(pkgPath: string): string | null {
    if (!pkgPath) return null;
    if (!pkgPath.includes('node_modules')) {
      return pkgPath.replace(/^node_modules\//, '') || null;
    }

    const segments = pkgPath.split('node_modules/');
    const last = segments[segments.length - 1];
    return last || null;
  }

  private evaluateVulnerabilities(dep: DependencyInfo): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    for (const vuln of KNOWN_VULNERABILITIES) {
      if (vuln.package !== dep.name) {
        continue;
      }

      if (this.isVersionLessThan(dep.version, vuln.fixedVersion)) {
        if (this.severityAllowed(vuln.severity)) {
          findings.push({
            ruleId: vuln.id,
            severity: vuln.severity,
            message: `${dep.name}@${dep.version} is vulnerable (${vuln.description})`,
            file: 'package-lock.json',
            remediation: vuln.remediation,
            confidence: 'high'
          });
        }
      }
    }
    return findings;
  }

  private evaluateLicenses(dep: DependencyInfo): SecurityFinding[] {
    if (!this.config.checkLicenses || !this.config.allowedLicenses || !dep.license) {
      return [];
    }

    const normalized = this.normalizeLicense(dep.license);
    if (!this.config.allowedLicenses.includes(normalized)) {
      return [{
        ruleId: 'DEPENDENCY-DISALLOWED-LICENSE',
        severity: 'medium',
        message: `${dep.name}@${dep.version} uses ${normalized} which is not in the allowed license list`,
        file: 'package-lock.json',
        remediation: 'Replace or relicense the dependency, or update the allowed license list after review.',
        confidence: 'medium'
      }];
    }
    return [];
  }

  private normalizeLicense(license: string): string {
    return license.replace(/\s+/g, '').split('(')[0];
  }

  private isVersionLessThan(current: string, fixed: string): boolean {
    const currentParts = current.split('.').map(part => parseInt(part, 10));
    const fixedParts = fixed.split('.').map(part => parseInt(part, 10));
    const length = Math.max(currentParts.length, fixedParts.length);

    for (let i = 0; i < length; i++) {
      const a = currentParts[i] ?? 0;
      const b = fixedParts[i] ?? 0;
      if (a < b) return true;
      if (a > b) return false;
    }
    return false; // equal
  }

  private severityAllowed(severity: SeverityLevel): boolean {
    const order: Record<SeverityLevel, number> = {
      info: 0,
      low: 1,
      medium: 2,
      high: 3,
      critical: 4
    };
    return order[severity] >= order[this.severityThreshold];
  }
}
