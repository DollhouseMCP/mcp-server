/**
 * Goal Template System for Agent Goal Management
 * 
 * Provides pre-configured goal templates for common patterns,
 * making it easier to create well-structured goals with appropriate
 * settings for different scenarios.
 */

import { GoalPriority, GoalStatus, EisenhowerQuadrant } from './types.js';

export interface GoalTemplate {
  id: string;
  name: string;
  description: string;
  category: 'development' | 'operations' | 'research' | 'planning' | 'maintenance' | 'custom';
  defaultValues: {
    priority: GoalPriority;
    importance: number;  // 1-10
    urgency: number;     // 1-10
    estimatedEffort?: number;  // hours
    riskLevel?: 'low' | 'medium' | 'high';
    tags?: string[];
  };
  requiredFields?: string[];
  suggestedDependencies?: string[];
  successCriteria?: string[];
  riskMitigations?: string[];
}

// Pre-defined goal templates
export const GOAL_TEMPLATES: Record<string, GoalTemplate> = {
  // Development templates
  'feature-implementation': {
    id: 'feature-implementation',
    name: 'Feature Implementation',
    description: 'Implement a new feature with proper testing and documentation',
    category: 'development',
    defaultValues: {
      priority: 'high',
      importance: 8,
      urgency: 5,
      estimatedEffort: 8,
      riskLevel: 'medium',
      tags: ['feature', 'development', 'implementation']
    },
    requiredFields: ['featureName', 'specifications'],
    successCriteria: [
      'Code implemented and tested',
      'Unit tests passing',
      'Documentation updated',
      'Code reviewed'
    ],
    riskMitigations: [
      'Break down into smaller tasks',
      'Early prototype validation',
      'Regular progress reviews'
    ]
  },

  'bug-fix-critical': {
    id: 'bug-fix-critical',
    name: 'Critical Bug Fix',
    description: 'Fix a critical production bug affecting users',
    category: 'maintenance',
    defaultValues: {
      priority: 'critical',
      importance: 10,
      urgency: 10,
      estimatedEffort: 2,
      riskLevel: 'high',
      tags: ['bug', 'critical', 'production']
    },
    requiredFields: ['bugId', 'impactDescription'],
    successCriteria: [
      'Bug identified and reproduced',
      'Fix implemented and tested',
      'Regression tests added',
      'Deployed to production'
    ],
    riskMitigations: [
      'Rollback plan prepared',
      'Thorough testing in staging',
      'Monitor after deployment'
    ]
  },

  'research-spike': {
    id: 'research-spike',
    name: 'Research Spike',
    description: 'Time-boxed research to explore technical options',
    category: 'research',
    defaultValues: {
      priority: 'medium',
      importance: 7,
      urgency: 3,
      estimatedEffort: 4,
      riskLevel: 'low',
      tags: ['research', 'spike', 'exploration']
    },
    requiredFields: ['researchQuestion', 'timeBox'],
    successCriteria: [
      'Research question answered',
      'Options documented',
      'Recommendations provided',
      'Decision criteria established'
    ]
  },

  'security-audit': {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Conduct security audit of system or component',
    category: 'operations',
    defaultValues: {
      priority: 'high',
      importance: 9,
      urgency: 6,
      estimatedEffort: 6,
      riskLevel: 'medium',
      tags: ['security', 'audit', 'compliance']
    },
    requiredFields: ['auditScope', 'complianceFramework'],
    successCriteria: [
      'Vulnerabilities identified',
      'Risk assessment completed',
      'Remediation plan created',
      'Report generated'
    ]
  },

  'performance-optimization': {
    id: 'performance-optimization',
    name: 'Performance Optimization',
    description: 'Optimize system performance based on metrics',
    category: 'maintenance',
    defaultValues: {
      priority: 'medium',
      importance: 6,
      urgency: 4,
      estimatedEffort: 8,
      riskLevel: 'medium',
      tags: ['performance', 'optimization', 'metrics']
    },
    requiredFields: ['performanceMetrics', 'targetImprovement'],
    successCriteria: [
      'Baseline metrics captured',
      'Optimizations implemented',
      'Performance improved by target %',
      'No regression in functionality'
    ]
  },

  'documentation-update': {
    id: 'documentation-update',
    name: 'Documentation Update',
    description: 'Update technical or user documentation',
    category: 'maintenance',
    defaultValues: {
      priority: 'low',
      importance: 5,
      urgency: 2,
      estimatedEffort: 3,
      riskLevel: 'low',
      tags: ['documentation', 'maintenance']
    },
    requiredFields: ['documentType', 'sections'],
    successCriteria: [
      'Documentation reviewed',
      'Updates completed',
      'Reviewed by stakeholders',
      'Published to appropriate location'
    ]
  },

  'quarterly-planning': {
    id: 'quarterly-planning',
    name: 'Quarterly Planning',
    description: 'Plan goals and priorities for the quarter',
    category: 'planning',
    defaultValues: {
      priority: 'high',
      importance: 9,
      urgency: 7,
      estimatedEffort: 12,
      riskLevel: 'low',
      tags: ['planning', 'quarterly', 'strategy']
    },
    requiredFields: ['quarter', 'objectives'],
    successCriteria: [
      'Goals defined and prioritized',
      'Resources allocated',
      'Timeline established',
      'Stakeholder alignment'
    ]
  },

  'custom-goal': {
    id: 'custom-goal',
    name: 'Custom Goal',
    description: 'Create a custom goal with your own parameters',
    category: 'custom',
    defaultValues: {
      priority: 'medium',
      importance: 5,
      urgency: 5,
      riskLevel: 'medium',
      tags: ['custom']
    }
  }
};

/**
 * Apply a goal template to create a new goal
 */
export function applyGoalTemplate(
  templateId: string,
  customFields: Record<string, any>
): Partial<any> {  // Returns partial AgentGoal
  const template = GOAL_TEMPLATES[templateId];
  if (!template) {
    throw new Error(`Goal template '${templateId}' not found`);
  }

  // Validate required fields
  if (template.requiredFields) {
    for (const field of template.requiredFields) {
      if (!customFields[field]) {
        throw new Error(`Required field '${field}' missing for template '${template.name}'`);
      }
    }
  }

  // Calculate Eisenhower quadrant based on template defaults
  const importance = customFields.importance || template.defaultValues.importance;
  const urgency = customFields.urgency || template.defaultValues.urgency;
  const eisenhowerQuadrant = calculateEisenhowerQuadrant(importance, urgency);

  // Ensure description is provided
  const description = customFields.description || 
    `${template.name}: ${template.requiredFields?.map(f => customFields[f]).filter(Boolean).join(' - ') || template.description}`;

  return {
    ...template.defaultValues,
    ...customFields,
    description,
    eisenhowerQuadrant,
    templateId,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

/**
 * Calculate Eisenhower quadrant from importance and urgency
 */
function calculateEisenhowerQuadrant(importance: number, urgency: number): EisenhowerQuadrant {
  if (importance >= 7 && urgency >= 7) return 'do_first';
  if (importance >= 7 && urgency < 7) return 'schedule';
  if (importance < 7 && urgency >= 7) return 'delegate';
  return 'eliminate';
}

/**
 * Get template recommendations based on goal description
 */
export function recommendGoalTemplate(description: string): string[] {
  const lowercaseDesc = description.toLowerCase();
  const recommendations: string[] = [];

  // Keywords mapping to templates
  const keywordMap: Record<string, string[]> = {
    'feature-implementation': ['feature', 'implement', 'develop', 'build'],
    'bug-fix-critical': ['bug', 'fix', 'critical', 'urgent', 'broken', 'error'],
    'research-spike': ['research', 'explore', 'investigate', 'spike', 'evaluate'],
    'security-audit': ['security', 'audit', 'vulnerability', 'compliance'],
    'performance-optimization': ['performance', 'optimize', 'speed', 'slow', 'latency'],
    'documentation-update': ['document', 'docs', 'readme', 'guide', 'manual'],
    'quarterly-planning': ['plan', 'quarter', 'roadmap', 'strategy']
  };

  // Check for keyword matches
  for (const [templateId, keywords] of Object.entries(keywordMap)) {
    if (keywords.some(keyword => lowercaseDesc.includes(keyword))) {
      recommendations.push(templateId);
    }
  }

  // Always include custom as an option
  if (recommendations.length === 0) {
    recommendations.push('custom-goal');
  }

  return recommendations;
}

/**
 * Validate goal against its template
 */
export function validateGoalAgainstTemplate(
  goal: any,  // AgentGoal type
  templateId?: string
): { valid: boolean; errors: string[] } {
  if (!templateId || !GOAL_TEMPLATES[templateId]) {
    return { valid: true, errors: [] };
  }

  const template = GOAL_TEMPLATES[templateId];
  const errors: string[] = [];

  // Check required fields
  if (template.requiredFields) {
    for (const field of template.requiredFields) {
      if (!goal[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Validate risk level matches template category
  if (template.category === 'operations' && goal.riskLevel === 'high') {
    errors.push('High risk operations goals require additional approval');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}