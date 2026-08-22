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
  licenseOverrides?: Record<string, string>;
}

interface KnownVulnerability {
  id: string;
  package: string;
  fixedVersion: string;
  affectedMajor?: number;
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
  },
  // Advisory snapshot for the dependency versions intentionally held under the
  // cooling/provenance policy in issues #2451 and #2452. Recording an advisory
  // here detects and fails on it; it does not authorize an upgrade.
  {
    id: 'DEPENDENCY-FAST-URI-HOST-CONFUSION',
    package: 'fast-uri',
    fixedVersion: '3.1.5',
    affectedMajor: 3,
    severity: 'high',
    description: 'fast-uri < 3.1.5 has host-confusion flaws involving backslash authorities and IDN canonicalization (GHSA-v2hh-gcrm-f6hx, GHSA-7p8r-x3mc-p8w7, GHSA-4c8g-83qw-93j6).',
    remediation: 'Review issues #2451/#2452, then upgrade fast-uri to a provenance-approved version >= 3.1.5.'
  },
  {
    id: 'DEPENDENCY-IP-ADDRESS-TRUST-BOUNDARY',
    package: 'ip-address',
    fixedVersion: '10.3.1',
    affectedMajor: 10,
    severity: 'high',
    description: 'ip-address <= 10.3.0 can misclassify resolver, CIDR, mapped IPv4, and NAT64 inputs, enabling SSRF or trust-boundary bypass (GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg).',
    remediation: 'Review issues #2451/#2452, then upgrade ip-address to a provenance-approved version >= 10.3.1.'
  },
  {
    id: 'DEPENDENCY-JS-YAML-3X-DOS',
    package: 'js-yaml',
    fixedVersion: '3.15.1',
    affectedMajor: 3,
    severity: 'high',
    description: 'js-yaml 3.x before 3.15.1 permits quadratic CPU consumption through merge-key aliases and !!omap resolution (GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj).',
    remediation: 'Review issues #2451/#2452, then upgrade the js-yaml 3.x consumer to a provenance-approved version >= 3.15.1.'
  },
  {
    id: 'DEPENDENCY-JS-YAML-4X-DOS',
    package: 'js-yaml',
    fixedVersion: '4.3.1',
    affectedMajor: 4,
    severity: 'high',
    description: 'js-yaml 4.x before 4.3.1 permits quadratic CPU consumption through merge-key aliases and !!omap resolution (GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj).',
    remediation: 'Review issues #2451/#2452, then upgrade js-yaml to a provenance-approved version >= 4.3.1.'
  },
  {
    id: 'DEPENDENCY-DOMPURIFY-XSS',
    package: 'dompurify',
    fixedVersion: '3.4.13',
    affectedMajor: 3,
    severity: 'medium',
    description: 'DOMPurify <= 3.4.12 has custom-element and detached-subtree sanitization bypasses (GHSA-c2j3-45gr-mqc4, GHSA-55q2-fjhq-7xh7).',
    remediation: 'Review issues #2451/#2452, then upgrade DOMPurify to a provenance-approved version >= 3.4.13.'
  },
  {
    id: 'DEPENDENCY-HONO-4X-REQUEST-SAFETY',
    package: 'hono',
    fixedVersion: '4.12.34',
    affectedMajor: 4,
    severity: 'medium',
    description: 'Hono < 4.12.34 has request-driven ReDoS/complexity flaws and cross-request memo disclosure (GHSA-8j4g-w8fx-2239, GHSA-f23p-vx2j-j53r, GHSA-54fx-42gc-7vw4).',
    remediation: 'Review issues #2451/#2452, then upgrade Hono to a provenance-approved version >= 4.12.34.'
  },
  {
    id: 'DEPENDENCY-HONO-NODE-SERVER-PATH-TRAVERSAL',
    package: '@hono/node-server',
    fixedVersion: '1.19.15',
    affectedMajor: 1,
    severity: 'medium',
    description: '@hono/node-server < 1.19.15 permits Windows serve-static path traversal through encoded backslashes (GHSA-frvp-7c67-39w9).',
    remediation: 'Review issues #2451/#2452, then upgrade @hono/node-server to a provenance-approved version >= 1.19.15.'
  },
  {
    id: 'DEPENDENCY-BODY-PARSER-LIMIT-DOS',
    package: 'body-parser',
    fixedVersion: '2.3.0',
    affectedMajor: 2,
    severity: 'low',
    description: 'body-parser 2.x before 2.3.0 can silently disable body-size enforcement for invalid limit values (GHSA-v422-hmwv-36x6).',
    remediation: 'Review issues #2451/#2452, then upgrade body-parser to a provenance-approved version >= 2.3.0.'
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
    const dependencies = await this.loadDependencies(context.projectRoot);
    if (dependencies.length === 0) {
      logger.debug('[DependencyScanner] No dependencies found to scan');
      return findings;
    }

    for (const dep of dependencies) {
      findings.push(...this.evaluateVulnerabilities(dep));
      findings.push(...this.evaluateLicenses(dep));
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

          const key = this.dependencyKey(name, pkgInfo.version);
          if (!deps.has(key)) {
            deps.set(key, {
              name,
              version: pkgInfo.version,
              license: pkgInfo.license || pkgInfo.licenses
            });
          }
        }
      }

      return Array.from(deps.values());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('[DependencyScanner] Unable to read package-lock.json', { path: lockPath, error: detail });
      throw new Error(`DependencyScanner could not read or parse ${lockPath}: ${detail}`, { cause: error });
    }
  }

  private collectFromDependencies(deps: Record<string, any>, map: Map<string, DependencyInfo>): void {
    for (const [name, info] of Object.entries<any>(deps)) {
      if (!info || !info.version) {
        continue;
      }

      const key = this.dependencyKey(name, info.version);
      if (!map.has(key)) {
        map.set(key, {
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

  private dependencyKey(name: string, version: string): string {
    return `${name}@${version}`;
  }

  private evaluateVulnerabilities(dep: DependencyInfo): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    for (const vuln of KNOWN_VULNERABILITIES) {
      if (vuln.package !== dep.name) {
        continue;
      }
      if (vuln.affectedMajor !== undefined && this.versionMajor(dep.version) !== vuln.affectedMajor) {
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

    const declared = this.config.licenseOverrides?.[dep.name] ?? dep.license;
    if (!this.isAllowedLicenseExpression(declared, new Set(this.config.allowedLicenses))) {
      return [{
        ruleId: 'DEPENDENCY-DISALLOWED-LICENSE',
        severity: 'medium',
        message: `${dep.name}@${dep.version} uses ${declared} which is not in the allowed license list`,
        file: 'package-lock.json',
        remediation: 'Replace or relicense the dependency, or update the allowed license list after review.',
        confidence: 'medium'
      }];
    }
    return [];
  }

  /**
   * Evaluate the small SPDX-expression subset emitted by package-lock.json.
   * An OR expression is acceptable when at least one complete licensing path
   * is approved; every license in an AND path must be approved. WITH clauses
   * remain explicit identifiers and therefore fail unless separately allowed.
   */
  private isAllowedLicenseExpression(expression: string, allowed: ReadonlySet<string>): boolean {
    const unwrapped = expression.trim().replace(/^\((.*)\)$/u, '$1');
    return unwrapped.split(/\s+OR\s+/iu).some(alternative =>
      alternative.split(/\s+AND\s+/iu).every(term => allowed.has(term.trim())));
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

  private versionMajor(version: string): number | null {
    const match = /^(\d+)/.exec(version);
    return match ? Number.parseInt(match[1], 10) : null;
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
