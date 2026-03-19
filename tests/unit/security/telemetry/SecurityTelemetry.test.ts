/**
 * Tests for Security Telemetry
 *
 * Issue #1269: Enhanced telemetry for memory injection protection
 * DI REFACTOR: Adapted for instance-based architecture
 * @jest-environment node
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SecurityTelemetry } from '../../../../src/security/telemetry/SecurityTelemetry.js';

describe('SecurityTelemetry', () => {
  let telemetry: SecurityTelemetry;

  beforeEach(() => {
    // Create fresh instance before each test
    telemetry = new SecurityTelemetry();
  });

  describe('Attack Recording', () => {
    it('should record blocked attack attempts', () => {
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'System prompt override',
        'CRITICAL',
        'content_validation'
      );

      const metrics = telemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(1);
      expect(metrics.criticalAttacksBlocked).toBe(1);
    });

    it('should track multiple attack vectors', () => {
      // Record different types of attacks
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'System prompt override',
        'CRITICAL',
        'content_validation'
      );

      telemetry.recordBlockedAttack(
        'UNICODE_ATTACK',
        'Direction override detected',
        'HIGH',
        'unicode_validation'
      );

      telemetry.recordBlockedAttack(
        'YAML_BOMB',
        'Recursive reference detected',
        'CRITICAL',
        'yaml_validation'
      );

      const metrics = telemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(3);
      expect(metrics.uniqueAttackVectors).toBe(3);
      expect(metrics.criticalAttacksBlocked).toBe(2);
      expect(metrics.highSeverityBlocked).toBe(1);
    });

    it('should aggregate repeated attack patterns', () => {
      // Same attack pattern multiple times
      for (let i = 0; i < 5; i++) {
        telemetry.recordBlockedAttack(
          'CONTENT_INJECTION',
          'System prompt override',
          'CRITICAL',
          'content_validation'
        );
      }

      const metrics = telemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(5);
      expect(metrics.topAttackVectors[0].count).toBe(5);
      expect(metrics.topAttackVectors[0].type).toBe('CONTENT_INJECTION');
    });
  });

  describe('Metrics and Reporting', () => {
    it('should calculate hourly distribution', () => {
      // Record attacks at different times
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test pattern',
        'HIGH',
        'test'
      );

      const metrics = telemetry.getMetrics();
      expect(metrics.attacksPerHour).toHaveLength(24);
      expect(metrics.attacksPerHour[23]).toBe(1); // Most recent hour
    });

    it('should generate security report', () => {
      // Add some test data
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'System prompt override',
        'CRITICAL',
        'content_validation'
      );

      const report = telemetry.generateReport();
      expect(report).toContain('Security Telemetry Report');
      expect(report).toContain('Total Blocked Attacks');
      expect(report).toContain('CONTENT_INJECTION');
    });

    it('should filter attack patterns by type', () => {
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Pattern A',
        'HIGH',
        'test'
      );

      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Pattern B',
        'HIGH',
        'test'
      );

      telemetry.recordBlockedAttack(
        'YAML_BOMB',
        'Pattern C',
        'CRITICAL',
        'test'
      );

      const patterns = telemetry.getAttackPatternsByType('CONTENT_INJECTION');
      expect(patterns).toHaveLength(2);
      expect(patterns).toContain('Pattern A');
      expect(patterns).toContain('Pattern B');
      expect(patterns).not.toContain('Pattern C');
    });

    it('should provide attack timeline', () => {
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test',
        'HIGH',
        'test'
      );

      const timeline = telemetry.getAttackTimeline(24);
      expect(timeline).toHaveLength(24);
      expect(timeline[23].count).toBeGreaterThan(0);
      expect(timeline[23].severity).toHaveProperty('HIGH', 1);
    });
  });

  describe('Data Management', () => {
    it('should clear old telemetry data', () => {
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test',
        'HIGH',
        'test'
      );

      expect(telemetry.getMetrics().totalBlockedAttempts).toBe(1);

      telemetry.clearOldData(0);
      expect(telemetry.getMetrics().totalBlockedAttempts).toBe(0);
    });

    it('should export telemetry data', () => {
      telemetry.recordBlockedAttack(
        'CONTENT_INJECTION',
        'Test pattern',
        'CRITICAL',
        'test'
      );

      const exported = telemetry.exportData();
      expect(exported).toHaveProperty('history');
      expect(exported).toHaveProperty('vectors');
      expect(exported).toHaveProperty('metrics');
      expect(exported.history.length).toBe(1);
    });

    it('should maintain circular buffer for attack history', () => {
      // Record more than max history (10000 attacks)
      // For testing, we'll just verify it doesn't crash
      for (let i = 0; i < 100; i++) {
        telemetry.recordBlockedAttack(
          'CONTENT_INJECTION',
          `Pattern ${i}`,
          'LOW',
          'test'
        );
      }

      const metrics = telemetry.getMetrics();
      expect(metrics.totalBlockedAttempts).toBe(100);
    });
  });

  describe('Severity Tracking', () => {
    it('should track attacks by severity level', () => {
      telemetry.recordBlockedAttack('ATTACK_1', 'Pattern', 'CRITICAL', 'test');
      telemetry.recordBlockedAttack('ATTACK_2', 'Pattern', 'HIGH', 'test');
      telemetry.recordBlockedAttack('ATTACK_3', 'Pattern', 'MEDIUM', 'test');
      telemetry.recordBlockedAttack('ATTACK_4', 'Pattern', 'LOW', 'test');

      const metrics = telemetry.getMetrics();
      expect(metrics.criticalAttacksBlocked).toBe(1);
      expect(metrics.highSeverityBlocked).toBe(1);
      expect(metrics.mediumSeverityBlocked).toBe(1);
      expect(metrics.lowSeverityBlocked).toBe(1);
    });
  });
});
