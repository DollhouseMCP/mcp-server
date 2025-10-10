/**
 * Tests for Security Telemetry
 *
 * Issue #1269: Enhanced telemetry for memory injection protection
 * @jest-environment node
 */

import { jest } from '@jest/globals';
import { SecurityTelemetry } from '../../../../../src/security/telemetry/SecurityTelemetry.js';

describe('SecurityTelemetry', () => {
  beforeEach(() => {
    // Clear telemetry data before each test
    SecurityTelemetry.clearOldData(0);
  });

  describe('Attack Recording', () => {
    it('should record blocked attack attempts', () => {
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'System prompt override',
        'CRITICAL',
        'content_validation'
      );

      const metrics = SecurityTelemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(1);
      expect(metrics.criticalAttacksBlocked).toBe(1);
    });

    it('should track multiple attack vectors', () => {
      // Record different types of attacks
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'System prompt override',
        'CRITICAL',
        'content_validation'
      );

      SecurityTelemetry.recordBlockedAttack(
        'UNICODE_ATTACK',
        'Direction override detected',
        'HIGH',
        'unicode_validation'
      );

      SecurityTelemetry.recordBlockedAttack(
        'YAML_BOMB',
        'Recursive reference detected',
        'CRITICAL',
        'yaml_validation'
      );

      const metrics = SecurityTelemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(3);
      expect(metrics.uniqueAttackVectors).toBe(3);
      expect(metrics.criticalAttacksBlocked).toBe(2);
      expect(metrics.highSeverityBlocked).toBe(1);
    });

    it('should aggregate repeated attack patterns', () => {
      // Same attack pattern multiple times
      for (let i = 0; i < 5; i++) {
        SecurityTelemetry.recordBlockedAttack(
          'CONTENT_INJECTION',
          'System prompt override',
          'CRITICAL',
          'content_validation'
        );
      }

      const metrics = SecurityTelemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(5);
      expect(metrics.topAttackVectors[0].count).toBe(5);
      expect(metrics.topAttackVectors[0].type).toBe('CONTENT_INJECTION');
    });
  });

  describe('Metrics and Reporting', () => {
    it('should calculate hourly distribution', () => {
      // Record attacks at different times
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test pattern',
        'HIGH',
        'test'
      );

      const metrics = SecurityTelemetry.getMetrics();
      expect(metrics.attacksPerHour).toHaveLength(24);
      expect(metrics.attacksPerHour[23]).toBe(1); // Most recent hour
    });

    it('should generate security report', () => {
      // Add some test data
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'System prompt override',
        'CRITICAL',
        'content_validation'
      );

      SecurityTelemetry.recordBlockedAttack(
        'UNICODE_ATTACK',
        'Mixed script detected',
        'MEDIUM',
        'unicode_validation'
      );

      const report = SecurityTelemetry.generateReport();
      expect(report).toContain('Security Telemetry Report');
      expect(report).toContain('Total Blocked Attacks (24h): 2');
      expect(report).toContain('Critical: 1');
      expect(report).toContain('Medium: 1');
    });

    it('should track top attack vectors', () => {
      // Create various attack patterns
      const attacks = [
        { type: 'CONTENT_INJECTION', pattern: 'System override', count: 10 },
        { type: 'UNICODE_ATTACK', pattern: 'Direction marks', count: 5 },
        { type: 'YAML_BOMB', pattern: 'Recursive ref', count: 3 },
        { type: 'DATA_EXFILTRATION', pattern: 'Export API keys', count: 8 }
      ];

      for (const attack of attacks) {
        for (let i = 0; i < attack.count; i++) {
          SecurityTelemetry.recordBlockedAttack(
            attack.type,
            attack.pattern,
            'HIGH',
            'test'
          );
        }
      }

      const metrics = SecurityTelemetry.getMetrics();
      expect(metrics.topAttackVectors[0].count).toBe(10);
      expect(metrics.topAttackVectors[0].blockedPatterns).toContain('System override');
    });
  });

  describe('Attack Pattern Analysis', () => {
    it('should retrieve patterns by attack type', () => {
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'System prompt override',
        'CRITICAL',
        'test'
      );

      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Instruction override',
        'CRITICAL',
        'test'
      );

      SecurityTelemetry.recordBlockedAttack(
        'UNICODE_ATTACK',
        'Direction marks',
        'HIGH',
        'test'
      );

      const injectionPatterns = SecurityTelemetry.getAttackPatternsByType('CONTENT_INJECTION');
      expect(injectionPatterns).toHaveLength(2);
      expect(injectionPatterns).toContain('System prompt override');
      expect(injectionPatterns).toContain('Instruction override');

      const unicodePatterns = SecurityTelemetry.getAttackPatternsByType('UNICODE_ATTACK');
      expect(unicodePatterns).toHaveLength(1);
      expect(unicodePatterns).toContain('Direction marks');
    });
  });

  describe('Timeline Analysis', () => {
    it('should generate attack timeline', () => {
      // Record attacks
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test',
        'CRITICAL',
        'test'
      );

      SecurityTelemetry.recordBlockedAttack(
        'UNICODE_ATTACK',
        'Test',
        'HIGH',
        'test'
      );

      const timeline = SecurityTelemetry.getAttackTimeline(1);
      expect(timeline).toHaveLength(1);
      // The timeline shows attacks in the most recent hour (0th element)
      // Both attacks were recorded in the same millisecond, so both are in current hour
      expect(timeline[0].count).toBe(2);
      expect(timeline[0].severity.CRITICAL).toBe(1);
      expect(timeline[0].severity.HIGH).toBe(1);
    });
  });

  describe('Data Management', () => {
    it('should export telemetry data', () => {
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test pattern',
        'HIGH',
        'test',
        { additional: 'metadata' }
      );

      const exportData = SecurityTelemetry.exportData();
      expect(exportData.history).toHaveLength(1);
      expect(exportData.vectors).toHaveLength(1);
      expect(exportData.metrics.totalBlockedAttempts).toBe(1);
      expect(exportData.history[0].metadata).toEqual({ additional: 'metadata' });
    });

    it('should clear old telemetry data', () => {
      // Record an attack
      SecurityTelemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test',
        'HIGH',
        'test'
      );

      // Clear all data (0 days to keep)
      SecurityTelemetry.clearOldData(0);

      const metrics = SecurityTelemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(0);
    });
  });
});