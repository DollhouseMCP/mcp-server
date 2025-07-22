/**
 * Rule Engine Configuration for Agent Decision Making
 * 
 * This configuration allows customization of the decision-making process
 * without modifying the core Agent implementation.
 */

import { SecurityMonitor } from '../../security/securityMonitor.js';

export interface RuleEngineConfig {
  // Rule-based decision thresholds
  ruleBased: {
    priority: {
      critical: 'critical';
      high: 'high';
      medium: 'medium';
      low: 'low';
    };
    urgencyThresholds: {
      immediate: number;  // Default: 8
      high: number;       // Default: 6
      medium: number;     // Default: 4
      low: number;        // Default: 2
    };
    confidence: {
      critical: number;        // Default: 0.95
      blocked: number;         // Default: 0.9
      riskApproval: number;    // Default: 0.85
      resourceLimit: number;   // Default: 0.8
      default: number;         // Default: 0.7
    };
  };

  // Programmatic decision scoring
  programmatic: {
    // Score weights for different factors
    scoreWeights: {
      eisenhower: {
        doFirst: number;     // Default: 30
        schedule: number;    // Default: 20
        delegate: number;    // Default: 10
        eliminate: number;   // Default: 0
      };
      risk: {
        low: number;         // Default: 20
        medium: number;      // Default: 10
        high: number;        // Default: -10
      };
      noDependencies: number; // Default: 15
      quickWin: number;       // Default: 15
      successBonus: number;   // Default: 10
    };
    
    // Score thresholds for actions
    actionThresholds: {
      executeImmediately: number;  // Default: 70
      proceed: number;             // Default: 50
      schedule: number;            // Default: 30
    };
    
    // Confidence mappings
    confidenceLevels: {
      executeImmediately: number;  // Default: 0.9
      proceed: number;             // Default: 0.8
      schedule: number;            // Default: 0.7
      review: number;              // Default: 0.6
    };
    
    // Other thresholds
    quickWinHours: number;         // Default: 2
    successRateThreshold: number;  // Default: 0.8
  };

  // Action definitions
  actions: {
    executeImmediately: string;
    proceedWithGoal: string;
    scheduleForLater: string;
    reviewAndRevise: string;
    waitForDependencies: string;
    requestApproval: string;
    queueForLater: string;
    reviewManually: string;
  };
}

// Default configuration
export const DEFAULT_RULE_ENGINE_CONFIG: RuleEngineConfig = {
  ruleBased: {
    priority: {
      critical: 'critical',
      high: 'high',
      medium: 'medium',
      low: 'low'
    },
    urgencyThresholds: {
      immediate: 8,
      high: 6,
      medium: 4,
      low: 2
    },
    confidence: {
      critical: 0.95,
      blocked: 0.9,
      riskApproval: 0.85,
      resourceLimit: 0.8,
      default: 0.7
    }
  },
  
  programmatic: {
    scoreWeights: {
      eisenhower: {
        doFirst: 30,
        schedule: 20,
        delegate: 10,
        eliminate: 0
      },
      risk: {
        low: 20,
        medium: 10,
        high: -10
      },
      noDependencies: 15,
      quickWin: 15,
      successBonus: 10
    },
    actionThresholds: {
      executeImmediately: 70,
      proceed: 50,
      schedule: 30
    },
    confidenceLevels: {
      executeImmediately: 0.9,
      proceed: 0.8,
      schedule: 0.7,
      review: 0.6
    },
    quickWinHours: 2,
    successRateThreshold: 0.8
  },
  
  actions: {
    executeImmediately: 'execute_immediately',
    proceedWithGoal: 'proceed_with_goal',
    scheduleForLater: 'schedule_for_later',
    reviewAndRevise: 'review_and_revise',
    waitForDependencies: 'wait_for_dependencies',
    requestApproval: 'request_approval',
    queueForLater: 'queue_for_later',
    reviewManually: 'review_manually'
  }
};

/**
 * Validate rule engine configuration
 */
export function validateRuleEngineConfig(config: Partial<RuleEngineConfig>): RuleEngineConfig {
  // SECURITY FIX: Add audit logging for configuration changes
  SecurityMonitor.logSecurityEvent({
    type: 'RULE_ENGINE_CONFIG_UPDATE',
    severity: 'LOW',
    source: 'validateRuleEngineConfig',
    details: 'Rule engine configuration update attempted'
  });

  // Deep merge with defaults
  const merged = JSON.parse(JSON.stringify(DEFAULT_RULE_ENGINE_CONFIG)) as RuleEngineConfig;
  
  if (config.ruleBased) {
    Object.assign(merged.ruleBased, config.ruleBased);
  }
  
  if (config.programmatic) {
    if (config.programmatic.scoreWeights) {
      Object.assign(merged.programmatic.scoreWeights, config.programmatic.scoreWeights);
    }
    if (config.programmatic.actionThresholds) {
      Object.assign(merged.programmatic.actionThresholds, config.programmatic.actionThresholds);
    }
    if (config.programmatic.confidenceLevels) {
      Object.assign(merged.programmatic.confidenceLevels, config.programmatic.confidenceLevels);
    }
    if (config.programmatic.quickWinHours !== undefined) {
      merged.programmatic.quickWinHours = config.programmatic.quickWinHours;
    }
    if (config.programmatic.successRateThreshold !== undefined) {
      merged.programmatic.successRateThreshold = config.programmatic.successRateThreshold;
    }
  }
  
  if (config.actions) {
    Object.assign(merged.actions, config.actions);
  }
  
  // Validate thresholds are in correct order
  if (merged.programmatic.actionThresholds.executeImmediately <= merged.programmatic.actionThresholds.proceed) {
    // SECURITY FIX: Log validation failures for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'RULE_ENGINE_CONFIG_VALIDATION_ERROR',
      severity: 'MEDIUM',
      source: 'validateRuleEngineConfig',
      details: 'Invalid threshold configuration attempted'
    });
    throw new Error('executeImmediately threshold must be higher than proceed threshold');
  }
  if (merged.programmatic.actionThresholds.proceed <= merged.programmatic.actionThresholds.schedule) {
    // SECURITY FIX: Log validation failures for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'RULE_ENGINE_CONFIG_VALIDATION_ERROR',
      severity: 'MEDIUM',
      source: 'validateRuleEngineConfig',
      details: 'Invalid threshold configuration attempted'
    });
    throw new Error('proceed threshold must be higher than schedule threshold');
  }
  
  // Validate confidence levels are between 0 and 1
  Object.values(merged.ruleBased.confidence).forEach(conf => {
    if (conf < 0 || conf > 1) {
      throw new Error('Confidence levels must be between 0 and 1');
    }
  });
  
  Object.values(merged.programmatic.confidenceLevels).forEach(conf => {
    if (conf < 0 || conf > 1) {
      throw new Error('Confidence levels must be between 0 and 1');
    }
  });
  
  return merged;
}