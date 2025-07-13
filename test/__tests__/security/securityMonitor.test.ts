/**
 * Tests for SecurityMonitor
 */

import { jest } from '@jest/globals';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';

describe('SecurityMonitor', () => {
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    
    // Clear any existing events
    // Use splice to clear the events array without reassigning
    SecurityMonitor['events'].splice(0, SecurityMonitor['events'].length);
    SecurityMonitor['eventCount'] = 0;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe('logSecurityEvent', () => {
    it('should store critical events in memory', () => {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'Critical injection detected'
      });

      const events = SecurityMonitor.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('CONTENT_INJECTION_ATTEMPT');
      expect(events[0].severity).toBe('CRITICAL');
      expect(events[0].details).toBe('Critical injection detected');
      // In test environment, console output is suppressed
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should store high severity events in memory', () => {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'test',
        details: 'Path traversal detected'
      });

      const events = SecurityMonitor.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe('HIGH');
      // In test environment, console output is suppressed
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should store medium severity events in memory', () => {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        source: 'test',
        details: 'Rate limit hit'
      });

      const events = SecurityMonitor.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe('MEDIUM');
      // In test environment, console output is suppressed
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should store low severity events in memory', () => {
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'LOW',
        source: 'test',
        details: 'Invalid token format'
      });

      const events = SecurityMonitor.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe('LOW');
      // In test environment, console output is suppressed
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should store events in memory', () => {
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'YAML injection'
      });

      const events = SecurityMonitor.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('YAML_INJECTION_ATTEMPT');
      expect(events[0].timestamp).toBeDefined();
      expect(events[0].id).toMatch(/^SEC-\d+-\d+$/);
    });

    it('should maintain circular buffer of MAX_EVENTS', () => {
      // Add more than MAX_EVENTS (1000)
      for (let i = 0; i < 1005; i++) {
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'LOW',
          source: 'test',
          details: `Event ${i}`
        });
      }

      const events = SecurityMonitor.getRecentEvents(2000);
      expect(events).toHaveLength(1000); // Should be capped at MAX_EVENTS
    });
  });

  describe('getRecentEvents', () => {
    beforeEach(() => {
      // Add test events
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'HIGH',
        source: 'test1',
        details: 'Event 1'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test2',
        details: 'Event 2'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'test3',
        details: 'Event 3'
      });
    });

    it('should return specified number of recent events', () => {
      const events = SecurityMonitor.getRecentEvents(2);
      expect(events).toHaveLength(2);
      expect(events[0].details).toBe('Event 2');
      expect(events[1].details).toBe('Event 3');
    });

    it('should return all events if count exceeds total', () => {
      const events = SecurityMonitor.getRecentEvents(10);
      expect(events).toHaveLength(3);
    });
  });

  describe('getEventsBySeverity', () => {
    beforeEach(() => {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'Critical 1'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'Critical 2'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'test',
        details: 'High 1'
      });
    });

    it('should filter events by severity', () => {
      const criticalEvents = SecurityMonitor.getEventsBySeverity('CRITICAL');
      expect(criticalEvents).toHaveLength(2);
      
      const highEvents = SecurityMonitor.getEventsBySeverity('HIGH');
      expect(highEvents).toHaveLength(1);
      
      const lowEvents = SecurityMonitor.getEventsBySeverity('LOW');
      expect(lowEvents).toHaveLength(0);
    });
  });

  describe('getEventsByType', () => {
    beforeEach(() => {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'HIGH',
        source: 'test',
        details: 'Injection 1'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'Injection 2'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'YAML 1'
      });
    });

    it('should filter events by type', () => {
      const contentEvents = SecurityMonitor.getEventsByType('CONTENT_INJECTION_ATTEMPT');
      expect(contentEvents).toHaveLength(2);
      
      const yamlEvents = SecurityMonitor.getEventsByType('YAML_INJECTION_ATTEMPT');
      expect(yamlEvents).toHaveLength(1);
    });
  });

  describe('generateSecurityReport', () => {
    beforeEach(() => {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'Critical injection'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'HIGH',
        source: 'test',
        details: 'YAML issue'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'test',
        details: 'Path issue'
      });
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'LOW',
        source: 'test',
        details: 'Rate limit'
      });
    });

    it('should generate comprehensive security report', () => {
      const report = SecurityMonitor.generateSecurityReport();
      
      expect(report.totalEvents).toBe(4);
      expect(report.eventsBySeverity.CRITICAL).toBe(1);
      expect(report.eventsBySeverity.HIGH).toBe(1);
      expect(report.eventsBySeverity.MEDIUM).toBe(1);
      expect(report.eventsBySeverity.LOW).toBe(1);
      
      expect(report.eventsByType['CONTENT_INJECTION_ATTEMPT']).toBe(1);
      expect(report.eventsByType['YAML_INJECTION_ATTEMPT']).toBe(1);
      expect(report.eventsByType['PATH_TRAVERSAL_ATTEMPT']).toBe(1);
      expect(report.eventsByType['RATE_LIMIT_EXCEEDED']).toBe(1);
      
      expect(report.recentCriticalEvents).toHaveLength(1);
    });
  });

  describe('clearOldEvents', () => {
    it('should remove events older than specified days', () => {
      // Add an old event
      const oldEvent = {
        type: 'CONTENT_INJECTION_ATTEMPT' as const,
        severity: 'HIGH' as const,
        source: 'test',
        details: 'Old event',
        timestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days old
        id: 'SEC-old-1'
      };
      
      SecurityMonitor['events'].unshift(oldEvent);
      
      // Add a recent event
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'CRITICAL',
        source: 'test',
        details: 'Recent event'
      });
      
      expect(SecurityMonitor.getRecentEvents()).toHaveLength(2);
      
      // Clear events older than 7 days
      SecurityMonitor.clearOldEvents(7);
      
      const remainingEvents = SecurityMonitor.getRecentEvents();
      expect(remainingEvents).toHaveLength(1);
      expect(remainingEvents[0].details).toBe('Recent event');
    });
  });
});