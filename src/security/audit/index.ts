/**
 * Security Audit Module - Main exports
 * Provides automated security scanning for DollhouseMCP
 */

export { SecurityAuditor } from './SecurityAuditor.js';
export * from './types.js';

// Re-export commonly used components
export { CodeScanner } from './scanners/CodeScanner.js';
export { DependencyScanner } from './scanners/DependencyScanner.js';
export { ConfigurationScanner } from './scanners/ConfigurationScanner.js';
export { ConsoleReporter } from './reporters/ConsoleReporter.js';
export { MarkdownReporter } from './reporters/MarkdownReporter.js';
export { JsonReporter } from './reporters/JsonReporter.js';
export { SecurityRules } from './rules/SecurityRules.js';