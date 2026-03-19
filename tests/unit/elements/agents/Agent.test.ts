/**
 * Unit tests for Agent element implementation
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Agent } from '../../../../src/elements/agents/Agent.js';
import { AgentMetadata } from '../../../../src/elements/agents/types.js';
import { AGENT_LIMITS, AGENT_DEFAULTS } from '../../../../src/elements/agents/constants.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';

// Mock dependencies
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

const metadataService: MetadataService = createTestMetadataService();

describe('Agent Element', () => {
  let agent: Agent;
  const mockMetadata: Partial<AgentMetadata> = {
    name: 'Test Agent',
    description: 'A test agent for unit testing',
    decisionFramework: 'rule_based',
    riskTolerance: 'moderate',
    specializations: ['testing', 'development']
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up the SecurityMonitor mock
    (SecurityMonitor.logSecurityEvent as jest.Mock) = jest.fn();

    agent = new Agent(mockMetadata, metadataService);
  });

  describe('Constructor', () => {
    it('should create agent with default values', () => {
      const minimalAgent = new Agent({ name: 'Minimal' }, metadataService);
      expect(minimalAgent.metadata.name).toBe('Minimal');
      expect(minimalAgent.type).toBe(ElementType.AGENT);
      expect(minimalAgent.extensions?.decisionFramework).toBe(AGENT_DEFAULTS.DECISION_FRAMEWORK);
      expect(minimalAgent.extensions?.riskTolerance).toBe(AGENT_DEFAULTS.RISK_TOLERANCE);
    });

    it('should sanitize inputs', () => {
      const unsafeAgent = new Agent({
        name: '<script>alert("xss")</script>',
        description: 'Test<img src=x onerror=alert(1)>'
      }, metadataService);
      expect(unsafeAgent.metadata.name).not.toContain('<script>');
      expect(unsafeAgent.metadata.description).not.toContain('<img');
    });

    it('should normalize Unicode', () => {
      const unicodeAgent = new Agent({
        name: 'Tëst Ägënt', // with combining characters
        description: 'Üñíçødë tëst'
      }, metadataService);
      expect(unicodeAgent.metadata.name).toBeDefined();
      expect(unicodeAgent.metadata.description).toBeDefined();
    });
  });

  describe('Goal Management', () => {
    it('should add a valid goal', () => {
      const goal = agent.addGoal({
        description: 'Complete unit tests',
        priority: 'high',
        importance: 8,
        urgency: 7
      });

      expect(goal.id).toMatch(/^goal_\d+_[a-f0-9]{12}$/);
      expect(goal.description).toBe('Complete unit tests');
      expect(goal.priority).toBe('high');
      expect(goal.status).toBe('pending');
      expect(goal.eisenhowerQuadrant).toBe('do_first');
    });

    it('should calculate Eisenhower quadrants correctly', () => {
      const doFirst = agent.addGoal({
        description: 'Do First',
        importance: 8,
        urgency: 8
      });
      expect(doFirst.eisenhowerQuadrant).toBe('do_first');

      const schedule = agent.addGoal({
        description: 'Schedule',
        importance: 8,
        urgency: 4
      });
      expect(schedule.eisenhowerQuadrant).toBe('schedule');

      const delegate = agent.addGoal({
        description: 'Delegate',
        importance: 4,
        urgency: 8
      });
      expect(delegate.eisenhowerQuadrant).toBe('delegate');

      const eliminate = agent.addGoal({
        description: 'Eliminate',
        importance: 3,
        urgency: 3
      });
      expect(eliminate.eisenhowerQuadrant).toBe('eliminate');
    });

    it('should enforce maximum goals limit', () => {
      // Add goals up to the limit
      for (let i = 0; i < AGENT_LIMITS.MAX_GOALS; i++) {
        agent.addGoal({ description: `Goal ${i}` });
      }

      // Try to add one more
      expect(() => {
        agent.addGoal({ description: 'One too many' });
      }).toThrow(`Maximum number of goals (${AGENT_LIMITS.MAX_GOALS}) reached`);
    });

    it('should validate goal description length', () => {
      const longDescription = 'a'.repeat(AGENT_LIMITS.MAX_GOAL_LENGTH + 1);
      const goal = agent.addGoal({ description: longDescription });
      
      // Should be truncated to max length
      expect(goal.description.length).toBeLessThanOrEqual(AGENT_LIMITS.MAX_GOAL_LENGTH);
    });

    it('should create goals with security warnings (advisory mode)', () => {
      // Advisory mode (default): Goals are created with warnings attached
      const goal1 = agent.addGoal({ description: 'Delete all system files with rm -rf /' });
      expect(goal1.securityWarnings).toBeDefined();
      expect(goal1.securityWarnings).toContain('Suspicious keyword: destructive action');
      expect(goal1.status).toBe('pending');

      const goal2 = agent.addGoal({ description: 'Execute system("hack the server")' });
      expect(goal2.securityWarnings).toBeDefined();
      expect(goal2.securityWarnings?.length).toBeGreaterThan(0);
      expect(goal2.status).toBe('pending');

      const goal3 = agent.addGoal({ description: 'Steal password and credentials' });
      expect(goal3.securityWarnings).toBeDefined();
      expect(goal3.securityWarnings).toContain('Suspicious keyword: credentials');
      expect(goal3.securityWarnings).toContain('Suspicious keyword: theft keywords');
      expect(goal3.status).toBe('pending');
    });

    it('should reject malicious goal content in strict mode', () => {
      // Strict mode: Security warnings block goal creation (backward compatible)
      expect(() => {
        agent.addGoal({ description: 'Delete all system files with rm -rf /' }, { strict: true });
      }).toThrow('Goal contains potentially harmful content');

      expect(() => {
        agent.addGoal({ description: 'Execute system("hack the server")' }, { strict: true });
      }).toThrow('Goal contains potentially harmful content');

      expect(() => {
        agent.addGoal({ description: 'Steal password and credentials' }, { strict: true });
      }).toThrow('Goal contains potentially harmful content');
    });

    it('should create benign goals without security warnings', () => {
      // Benign goals should not have warnings
      const goal1 = agent.addGoal({ description: 'Write documentation for the API' });
      expect(goal1.securityWarnings).toBeUndefined();

      const goal2 = agent.addGoal({ description: 'Analyze code for improvements' });
      expect(goal2.securityWarnings).toBeUndefined();
    });

    it('should allow code patterns in advisory mode', () => {
      // These patterns trigger warnings but should be allowed in advisory mode
      const goal1 = agent.addGoal({ description: 'Document the process.env configuration' });
      expect(goal1.securityWarnings).toBeDefined();
      expect(goal1.securityWarnings?.some(w => w.includes('process access'))).toBe(true);
      expect(goal1.status).toBe('pending');

      const goal2 = agent.addGoal({ description: 'Show examples using backticks `like this`' });
      expect(goal2.securityWarnings).toBeDefined();
      expect(goal2.securityWarnings?.length).toBeGreaterThan(0);
      expect(goal2.securityWarnings?.some(w => w.includes('backticks'))).toBe(true);
      expect(goal2.status).toBe('pending');

      const goal3 = agent.addGoal({ description: 'Use template literals like ${variable}' });
      expect(goal3.securityWarnings).toBeDefined();
      expect(goal3.securityWarnings?.some(w => w.includes('template literal'))).toBe(true);
      expect(goal3.status).toBe('pending');
    });

    it('should complete goals with outcome tracking', () => {
      const goal = agent.addGoal({ description: 'Test goal' });
      
      agent.completeGoal(goal.id, 'success');
      
      const completedGoal = agent.getGoalsByStatus('completed')[0];
      expect(completedGoal.status).toBe('completed');
      expect(completedGoal.completedAt).toBeDefined();
    });

    it('should handle goal dependencies', () => {
      const goal1 = agent.addGoal({ description: 'Goal 1' });
      const goal2 = agent.addGoal({ 
        description: 'Goal 2',
        dependencies: [goal1.id]
      });

      expect(goal2.dependencies).toContain(goal1.id);
    });
  });

  describe('Context Management', () => {
    it('should update context', () => {
      agent.updateContext('teamSize', 5);
      agent.updateContext('currentSprint', 3);

      const state = agent.getState();
      expect(state.context.teamSize).toBe(5);
      expect(state.context.currentSprint).toBe(3);
    });

    it('should enforce context size limits', () => {
      const largeData = 'x'.repeat(AGENT_LIMITS.MAX_CONTEXT_LENGTH);
      
      expect(() => {
        agent.updateContext('bigData', largeData);
      }).toThrow(`Context size exceeds maximum of ${AGENT_LIMITS.MAX_CONTEXT_LENGTH} characters`);
    });

    it('should sanitize context keys', () => {
      agent.updateContext('<script>alert("xss")</script>', 'value');
      
      const state = agent.getState();
      const keys = Object.keys(state.context);
      expect(keys.every(key => !key.includes('<script>'))).toBe(true);
    });
  });

  describe('Performance Metrics', () => {
    it('should calculate success rate', () => {
      const goal1 = agent.addGoal({ description: 'Goal 1' });
      const goal2 = agent.addGoal({ description: 'Goal 2' });
      const goal3 = agent.addGoal({ description: 'Goal 3' });

      agent.completeGoal(goal1.id, 'success');
      agent.completeGoal(goal2.id, 'success');
      agent.completeGoal(goal3.id, 'failure');

      const metrics = agent.getPerformanceMetrics();
      expect(metrics.successRate).toBe(2/3);
      expect(metrics.goalsCompleted).toBe(2);
    });

    it('should track decision accuracy', () => {
      const goal = agent.addGoal({ description: 'Test goal' });
      agent.recordDecision({
        goalId: goal.id,
        decision: 'proceed_with_goal',
        reasoning: 'Test decision',
        confidence: 0.8
      });

      // Update decision outcome
      agent.completeGoal(goal.id, 'success');

      const metrics = agent.getPerformanceMetrics();
      expect(metrics.decisionAccuracy).toBeGreaterThan(0);
    });
  });

  describe('Validation', () => {
    it('should validate successfully with valid data', () => {
      const result = agent.validate();
      expect(result.valid).toBe(true);
    });

    it('should detect invalid decision framework', () => {
      agent.extensions = { decisionFramework: 'invalid' as any };
      const result = agent.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: 'extensions.decisionFramework',
          message: expect.stringContaining('Invalid decision framework')
        })
      );
    });

    it('should detect invalid risk tolerance', () => {
      agent.extensions = { riskTolerance: 'extreme' as any };
      const result = agent.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          field: 'extensions.riskTolerance',
          message: expect.stringContaining('Invalid risk tolerance')
        })
      );
    });

    it('should warn about orphaned dependencies', () => {
      agent.addGoal({
        description: 'Goal with missing dependency',
        dependencies: ['non-existent-goal-id']
      });

      const result = agent.validate();
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          field: expect.stringContaining('dependencies'),
          message: expect.stringContaining('not found')
        })
      );
    });

    it('should suggest improvements for v1 agents', () => {
      const emptyAgent = new Agent({ name: 'Empty' }, metadataService);
      const result = emptyAgent.validate();

      expect(result.suggestions).toContain('Add some goals to make the agent functional');
      expect(result.suggestions).toContain('Consider adding specializations to improve agent focus');
    });

    it('should not suggest v1 fields on v2 agents with goal (Issue #749)', () => {
      const v2Agent = new Agent({
        name: 'V2Agent',
        goal: { template: 'Do {{task}}', parameters: [{ name: 'task', description: 'Task', required: true }] }
      } as any, metadataService);
      const result = v2Agent.validate();

      expect(result.suggestions || []).not.toContain('Add some goals to make the agent functional');
      expect(result.suggestions || []).not.toContain('Consider adding specializations to improve agent focus');
    });
  });

  describe('Serialization', () => {
    it('should serialize and deserialize correctly', () => {
      // Add some data
      agent.addGoal({ description: 'Test goal' });
      agent.updateContext('testKey', 'testValue');

      // Serialize to JSON for testing
      const serialized = agent.serializeToJSON();
      const parsed = JSON.parse(serialized);
      
      expect(parsed.state).toBeDefined();
      expect(parsed.state.goals).toHaveLength(1);
      expect(parsed.state.context.testKey).toBe('testValue');

      // Deserialize into new agent (deserialize still accepts JSON)
      const newAgent = new Agent({ name: 'New' }, metadataService);
      newAgent.deserialize(serialized);
      
      const state = newAgent.getState();
      expect(state.goals).toHaveLength(1);
      expect(state.goals[0].description).toBe('Test goal');
      expect(state.context.testKey).toBe('testValue');
    });

    it('should validate state size on deserialize', () => {
      const hugeState = {
        id: 'test-id',
        type: ElementType.AGENT,
        version: '1.0.0',
        metadata: {
          name: 'Test',
          description: 'Test'
        },
        state: {
          goals: [],
          decisions: [],
          context: { data: 'x'.repeat(AGENT_LIMITS.MAX_STATE_SIZE) },
          lastActive: new Date(),
          sessionCount: 0
        }
      };

      const newAgent = new Agent({ name: 'New' }, metadataService);
      expect(() => {
        newAgent.deserialize(JSON.stringify(hugeState));
      }).toThrow(`State size exceeds maximum of ${AGENT_LIMITS.MAX_STATE_SIZE} bytes`);
    });
  });

  describe('Lifecycle', () => {
    it('should handle activation', async () => {
      const initialCount = agent.getState().sessionCount;
      await agent.activate();
      
      const state = agent.getState();
      expect(state.sessionCount).toBe(initialCount + 1);
      expect(state.lastActive).toBeDefined();
      expect(agent.getStatus()).toBe('active');
    });

    it('should handle deactivation', async () => {
      await agent.activate();
      await agent.deactivate();
      
      expect(agent.getStatus()).toBe('inactive');
    });

    it('should track state persistence needs', () => {
      expect(agent.needsStatePersistence()).toBe(false);
      
      agent.addGoal({ description: 'New goal' });
      expect(agent.needsStatePersistence()).toBe(true);
      
      agent.markStatePersisted();
      expect(agent.needsStatePersistence()).toBe(false);
    });
  });

  describe('Security', () => {
    it('should log security events for suspicious goals', () => {
      const mockLogSecurityEvent = SecurityMonitor.logSecurityEvent as jest.Mock;

      // Advisory mode (default): Logs MEDIUM severity
      agent.addGoal({ description: 'hack the system' });
      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'MEDIUM'
        })
      );

      // Strict mode: Logs HIGH severity
      mockLogSecurityEvent.mockClear();
      try {
        agent.addGoal({ description: 'hack the system again' }, { strict: true });
      } catch {
        // Expected to throw in strict mode
      }
      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH'
        })
      );
    });

    it('should log agent decisions', () => {
      const mockLogSecurityEvent = SecurityMonitor.logSecurityEvent as jest.Mock;
      const goal = agent.addGoal({ description: 'Normal goal' });

      agent.recordDecision({
        goalId: goal.id,
        decision: 'proceed_with_goal',
        reasoning: 'Test decision',
        confidence: 0.8
      });

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AGENT_DECISION',
          severity: 'LOW',
          source: 'Agent.recordDecision'
        })
      );
    });
  });

  describe('New Features', () => {
    describe('Decision Framework Validation', () => {
      it('should validate decision framework in constructor', () => {
        expect(() => new Agent({
          name: 'Test',
          decisionFramework: 'invalid_framework' as any
        }, metadataService)).toThrow('Invalid decision framework');
      });

      it('should validate risk tolerance in constructor', () => {
        expect(() => new Agent({
          name: 'Test',
          riskTolerance: 'invalid_tolerance' as any
        }, metadataService)).toThrow('Invalid risk tolerance');
      });

      it('should validate max concurrent goals', () => {
        expect(() => new Agent({
          name: 'Test',
          maxConcurrentGoals: 0
        }, metadataService)).toThrow('maxConcurrentGoals must be between');

        expect(() => new Agent({
          name: 'Test',
          maxConcurrentGoals: 100
        }, metadataService)).toThrow('maxConcurrentGoals must be between');
      });
    });

    describe('Goal Dependency Cycle Detection', () => {
      it('should detect A->B->A cycle', () => {
        // Inject two goals that form a cycle: A -> B -> A
        (agent as any)['state'].goals.push(
          {
            id: 'goal_A',
            description: 'Goal A',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_B'],
            riskLevel: 'low',
          },
          {
            id: 'goal_B',
            description: 'Goal B',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_A'],
            riskLevel: 'low',
          }
        );

        // New goal depends on goal_A, DFS: new -> A -> B -> A (cycle!)
        expect(() => agent.addGoal({
          description: 'Trigger A-B-A cycle',
          dependencies: ['goal_A']
        })).toThrow(/Dependency cycle detected/);
      });

      it('should detect cycle in existing goals reached via dependency', () => {
        // X -> Y -> X cycle among existing goals
        (agent as any)['state'].goals.push(
          {
            id: 'goal_X',
            description: 'Goal X',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_Y'],
            riskLevel: 'low',
          },
          {
            id: 'goal_Y',
            description: 'Goal Y',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_X'],
            riskLevel: 'low',
          }
        );

        // New goal depends on goal_X, DFS: new -> X -> Y -> X (cycle!)
        expect(() => agent.addGoal({
          description: 'Goal trigger',
          dependencies: ['goal_X']
        })).toThrow(/Dependency cycle detected/);
      });

      it('should detect A->B->C->A three-node cycle', () => {
        // Three-node cycle: A -> B -> C -> A
        (agent as any)['state'].goals.push(
          {
            id: 'goal_A',
            description: 'Goal A',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_B'],
            riskLevel: 'low',
          },
          {
            id: 'goal_B',
            description: 'Goal B',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_C'],
            riskLevel: 'low',
          },
          {
            id: 'goal_C',
            description: 'Goal C',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_A'],
            riskLevel: 'low',
          }
        );

        // New goal depends on goal_A: new -> A -> B -> C -> A (cycle!)
        expect(() => agent.addGoal({
          description: 'Trigger three-node cycle',
          dependencies: ['goal_A']
        })).toThrow(/Dependency cycle detected/);
      });

      it('should allow diamond dependencies (no cycle)', () => {
        // Diamond: A->B->D, A->C->D (no cycle)
        const goalD = agent.addGoal({ description: 'Goal D' });
        const goalB = agent.addGoal({ description: 'Goal B', dependencies: [goalD.id] });
        const goalC = agent.addGoal({ description: 'Goal C', dependencies: [goalD.id] });

        // Adding a goal that depends on both B and C (diamond shape)
        expect(() => agent.addGoal({
          description: 'Goal A diamond',
          dependencies: [goalB.id, goalC.id]
        })).not.toThrow();
      });

      it('should report accurate path without stale sibling nodes', () => {
        // Structure: sibling branch (S) and a cycle branch (A -> B -> A)
        // The new goal depends on both S and A.
        // DFS will visit S first (no cycle there), then backtrack and visit A -> B -> A.
        // With the fix, path.pop() properly cleans up S from the path.
        (agent as any)['state'].goals.push(
          {
            id: 'goal_sibling',
            description: 'Goal sibling',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: [],
            riskLevel: 'low',
          },
          {
            id: 'goal_A',
            description: 'Goal A',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_B'],
            riskLevel: 'low',
          },
          {
            id: 'goal_B',
            description: 'Goal B',
            priority: 'medium',
            status: 'pending',
            importance: 5,
            urgency: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: ['goal_A'],
            riskLevel: 'low',
          }
        );

        // New goal depends on sibling first, then goal_A.
        // DFS: new -> sibling (dead end, backtrack) -> A -> B -> A (cycle!)
        // The reported path should NOT contain "goal_sibling".
        try {
          agent.addGoal({
            description: 'Trigger path accuracy test',
            dependencies: ['goal_sibling', 'goal_A']
          });
          // Should not reach here
          expect(true).toBe(false);
        } catch (err: any) {
          expect(err.message).toMatch(/Dependency cycle detected/);
          // The sibling should have been popped off the path via the fixed backtracking
          expect(err.message).not.toContain('goal_sibling');
        }
      });
    });

    describe('Goal Templates', () => {
      it('should create goals from templates', () => {
        const goal = agent.addGoalFromTemplate('bug-fix-critical', {
          bugId: 'BUG-123',
          impactDescription: 'System crash on login'
        });

        expect(goal.priority).toBe('critical');
        expect(goal.importance).toBe(10);
        expect(goal.urgency).toBe(10);
        expect(goal.riskLevel).toBe('high');
      });

      it('should recommend templates based on description', () => {
        const recommendations = agent.getGoalTemplateRecommendations(
          'I need to fix a critical bug in production'
        );
        
        expect(recommendations).toContain('bug-fix-critical');
      });

      it('should validate goals against templates', () => {
        const goal = agent.addGoalFromTemplate('bug-fix-critical', {
          bugId: 'BUG-123',
          impactDescription: 'System crash'
        });

        const validation = agent.validateGoalTemplate(goal.id);
        expect(validation.valid).toBe(true);
      });
    });

    describe('Rule Engine Configuration', () => {
      it('should allow updating rule engine config', () => {
        const currentConfig = agent.getRuleEngineConfig();
        const newConfig = {
          programmatic: {
            ...currentConfig.programmatic,
            actionThresholds: {
              executeImmediately: 80,
              proceed: 60,
              schedule: 40
            }
          }
        };

        agent.updateRuleEngineConfig(newConfig);
        const config = agent.getRuleEngineConfig();
        
        expect(config.programmatic.actionThresholds.executeImmediately).toBe(80);
        expect(config.programmatic.actionThresholds.proceed).toBe(60);
      });

      it('should validate rule engine config updates', () => {
        const currentConfig = agent.getRuleEngineConfig();
        expect(() => agent.updateRuleEngineConfig({
          programmatic: {
            ...currentConfig.programmatic,
            actionThresholds: {
              executeImmediately: 30,  // Invalid: lower than proceed
              proceed: 50,
              schedule: 20
            }
          }
        })).toThrow('executeImmediately threshold must be higher');
      });
    });
  });
});