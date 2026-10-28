#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reporting must never turn an unavailable/malformed audit into zero findings. */
export function toSarif(result, cwd = process.cwd()) {
  if (!result || result.error || !Array.isArray(result.findings)) {
    throw new Error('A completed security audit with a findings array is required');
  }
  const rules = new Map();
  const levels = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
  const results = result.findings.map(finding => {
    if (!finding || typeof finding.ruleId !== 'string' || !finding.ruleId.trim()
      || typeof finding.message !== 'string' || !finding.message.trim()
      || !Object.hasOwn(levels, finding.severity)) {
      throw new Error('Security finding is missing a valid rule, message or severity');
    }
    const ruleId = finding.ruleId;
    if (!rules.has(ruleId)) rules.set(ruleId, { id: ruleId });
    const entry = { ruleId, level: levels[finding.severity], message: { text: finding.message } };
    if (finding.file) {
      if (typeof finding.file !== 'string') throw new Error('Security finding file must be a string');
      const file = isAbsolute(finding.file) ? relative(cwd, finding.file) : finding.file;
      const line = finding.line ?? 1;
      if (!Number.isInteger(line) || line < 1) throw new Error('Security finding line must be positive');
      entry.locations = [{ physicalLocation: {
        artifactLocation: { uri: encodeURI(file.replaceAll('\\', '/')) },
        region: { startLine: line, startColumn: 1 },
      } }];
    }
    return entry;
  });
  return { version: '2.1.0', runs: [{
    tool: { driver: { name: 'DollhouseMCP Security Audit', version: '1.0.0', rules: [...rules.values()] } },
    results,
  }] };
}

export function isAuditComplete(result, { auditFailed, auditOutcome, sarifOutcome }) {
  if (auditFailed || auditOutcome !== 'success' || sarifOutcome !== 'success') return false;
  try { toSarif(result); return true; } catch { return false; }
}

export async function preserveFailedAudit(input) {
  try {
    if ((await readFile(input, 'utf8')).length) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(input, JSON.stringify({ error: 'Audit failed to complete' }));
}

export async function writeSarif(input, output) {
  const result = JSON.parse(await readFile(input, 'utf8'));
  const sarif = toSarif(result);
  await writeFile(output, JSON.stringify(sarif, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'preserve-failure') {
      await preserveFailedAudit(process.argv[3] ?? 'security-audit-result.json');
    } else {
      await writeSarif(process.argv[2] ?? 'security-audit-result.json', process.argv[3] ?? 'security-audit.sarif');
    }
  } catch (error) {
    console.error('Security audit SARIF generation failed:', error.message);
    process.exitCode = 1;
  }
}
