/**
 * Security Monitor for DollhouseMCP
 * 
 * Centralized security event logging and monitoring system
 * for tracking and alerting on security-related events.
 */

export interface SecurityEvent {
  type: 'CONTENT_INJECTION_ATTEMPT' | 'YAML_INJECTION_ATTEMPT' | 'PATH_TRAVERSAL_ATTEMPT' | 
        'TOKEN_VALIDATION_FAILURE' | 'UPDATE_SECURITY_VIOLATION' | 'RATE_LIMIT_EXCEEDED' |
        'YAML_PARSING_WARNING' | 'YAML_PARSE_SUCCESS';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  source: string;
  details: string;
  userAgent?: string;
  ip?: string;
  additionalData?: Record<string, any>;
}

export interface SecurityLogEntry extends SecurityEvent {
  timestamp: string;
  id: string;
}

export class SecurityMonitor {
  private static eventCount = 0;
  private static readonly events: SecurityLogEntry[] = [];
  private static readonly MAX_EVENTS = 1000; // Keep last 1000 events in memory

  /**
   * Logs a security event
   */
  static logSecurityEvent(event: SecurityEvent): void {
    const logEntry: SecurityLogEntry = {
      ...event,
      timestamp: new Date().toISOString(),
      id: `SEC-${Date.now()}-${++this.eventCount}`,
    };

    // Store in memory (circular buffer)
    this.events.push(logEntry);
    if (this.events.length > this.MAX_EVENTS) {
      this.events.shift();
    }

    // Log to console with appropriate level
    const logMessage = `[SECURITY] ${JSON.stringify(logEntry)}`;
    
    switch (event.severity) {
      case 'CRITICAL':
        console.error(logMessage);
        this.sendSecurityAlert(logEntry);
        break;
      case 'HIGH':
        console.error(logMessage);
        break;
      case 'MEDIUM':
        console.warn(logMessage);
        break;
      case 'LOW':
        console.log(logMessage);
        break;
    }
  }

  /**
   * Sends security alerts for critical events
   */
  private static sendSecurityAlert(event: SecurityLogEntry): void {
    // In a production environment, this would integrate with:
    // - Slack webhooks
    // - Email alerts
    // - PagerDuty
    // - Security Information and Event Management (SIEM) systems
    
    console.error(`🚨 CRITICAL SECURITY ALERT 🚨`);
    console.error(`Type: ${event.type}`);
    console.error(`Details: ${event.details}`);
    console.error(`Timestamp: ${event.timestamp}`);
    
    // If in production mode with proper config, send actual alerts
    if (process.env.DOLLHOUSE_SECURITY_ALERTS === 'true') {
      // TODO: Implement actual alert mechanisms
    }
  }

  /**
   * Gets recent security events for analysis
   */
  static getRecentEvents(count: number = 100): SecurityLogEntry[] {
    return this.events.slice(-count);
  }

  /**
   * Gets events by severity
   */
  static getEventsBySeverity(severity: SecurityEvent['severity']): SecurityLogEntry[] {
    return this.events.filter(event => event.severity === severity);
  }

  /**
   * Gets events by type
   */
  static getEventsByType(type: SecurityEvent['type']): SecurityLogEntry[] {
    return this.events.filter(event => event.type === type);
  }

  /**
   * Generates a security report
   */
  static generateSecurityReport(): {
    totalEvents: number;
    eventsBySeverity: Record<string, number>;
    eventsByType: Record<string, number>;
    recentCriticalEvents: SecurityLogEntry[];
  } {
    const eventsBySeverity: Record<string, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };

    const eventsByType: Record<string, number> = {};

    for (const event of this.events) {
      eventsBySeverity[event.severity]++;
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    }

    return {
      totalEvents: this.events.length,
      eventsBySeverity,
      eventsByType,
      recentCriticalEvents: this.getEventsBySeverity('CRITICAL').slice(-10),
    };
  }

  /**
   * Clears old events (for memory management)
   */
  static clearOldEvents(daysToKeep: number = 7): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTimestamp = cutoffDate.toISOString();

    const index = this.events.findIndex(event => event.timestamp >= cutoffTimestamp);
    if (index > 0) {
      this.events.splice(0, index);
    }
  }
}