/**
 * Integration tests for Agent V2 field round-trip (Issue #722)
 *
 * Validates that ALL V2 agent fields survive the full pipeline:
 *   OperationSchema → SchemaDispatcher → createElement → AgentManager.create
 *   → serializeElement → file → parseElement → get_element_details
 *
 * This test creates a V2 agent with every supported field passed at the
 * params level (as an LLM would), then:
 *   1. Verifies the raw file contains all fields in YAML frontmatter + markdown body
 *   2. Reads back via get_element_details and verifies all fields appear in the response
 *   3. Verifies V1 defaults (decisionFramework, riskTolerance, etc.) are NOT present
 *   4. Verifies content vs instructions dual-field routing is correct
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import {
  createPortfolioTestEnvironment,
  preConfirmAllOperations,
  waitForCacheSettle,
  type PortfolioTestEnvironment,
} from '../../helpers/portfolioTestHelper.js';
import path from 'path';
import fs from 'fs/promises';

/**
 * Canonical V2 agent fixture with every field populated.
 * This mirrors what an LLM would pass when creating a fully-specified agent.
 */
const V2_AGENT_PARAMS = {
  element_name: 'v2-roundtrip-agent',
  element_type: 'agents',
  description: 'Integration test agent with all V2 fields',
  instructions: 'You are a methodical code reviewer. ALWAYS check security first. Report issues by severity.',
  content: '# Code Review Reference\n\nOWASP Top 10 checklist and CWE/SANS Top 25 patterns.',
  goal: {
    template: 'Review {files} for {review_type} issues',
    parameters: [
      { name: 'files', type: 'string', required: true, description: 'Files to review' },
      { name: 'review_type', type: 'string', required: true, description: 'Type of review' },
    ],
    successCriteria: ['All files reviewed', 'Issues documented with severity'],
  },
  activates: {
    skills: ['code-review', 'security-audit'],
    personas: ['developer'],
    memories: ['project-context'],
  },
  tools: {
    allowed: ['read_file', 'grep', 'list_files'],
    denied: ['write_file', 'execute'],
  },
  systemPrompt: 'You are an automated code review agent operating in a CI pipeline.',
  autonomy: {
    riskTolerance: 'conservative',
    maxAutonomousSteps: 25,
    requiresApproval: ['delete_*', 'deploy_*'],
    autoApprove: ['read_*', 'list_*'],
  },
  resilience: {
    onStepLimitReached: 'pause',
    onExecutionFailure: 'retry',
    maxRetries: 3,
    maxContinuations: 5,
    retryBackoff: 'exponential',
    preserveState: true,
  },
  tags: ['code-review', 'security', 'automation'],
  triggers: ['review', 'audit', 'analyze'],
};

describe('Agent V2 field round-trip (Issue #722)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('agent-v2-roundtrip');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize container
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  it('should create a V2 agent with all fields via the full MCP pipeline', async () => {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: V2_AGENT_PARAMS,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeDefined();
    }

    // Verify the file was created
    const agentFile = path.join(env.testDir, 'agents', 'v2-roundtrip-agent.md');
    await expect(fs.access(agentFile)).resolves.toBeUndefined();
  });

  it('should persist all V2 fields in the agent file (YAML frontmatter + markdown body)', async () => {
    const createResult = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: V2_AGENT_PARAMS,
    });
    expect(createResult.success).toBe(true);

    const agentFile = path.join(env.testDir, 'agents', 'v2-roundtrip-agent.md');
    const fileContent = await fs.readFile(agentFile, 'utf-8');

    // --- YAML frontmatter assertions ---

    // Goal (V2 required)
    expect(fileContent).toContain('goal:');
    expect(fileContent).toContain('Review {files} for {review_type} issues');
    expect(fileContent).toContain('successCriteria:');

    // Activates
    expect(fileContent).toContain('activates:');
    expect(fileContent).toContain('code-review');
    expect(fileContent).toContain('security-audit');
    expect(fileContent).toContain('developer');
    expect(fileContent).toContain('project-context');

    // Tools
    expect(fileContent).toContain('tools:');
    expect(fileContent).toContain('read_file');
    expect(fileContent).toContain('write_file');

    // System prompt
    expect(fileContent).toContain('systemPrompt:');
    expect(fileContent).toContain('automated code review agent');

    // Autonomy
    expect(fileContent).toContain('autonomy:');
    expect(fileContent).toContain('conservative');
    expect(fileContent).toContain('25'); // max_autonomous_steps

    // Resilience (camelCase keys must match AgentResiliencePolicy type)
    expect(fileContent).toContain('resilience:');
    expect(fileContent).toContain('onStepLimitReached:');
    expect(fileContent).toContain('onExecutionFailure:');

    // Tags
    expect(fileContent).toContain('tags:');
    expect(fileContent).toContain('automation');

    // Triggers
    expect(fileContent).toContain('triggers:');
    expect(fileContent).toContain('review');
    expect(fileContent).toContain('audit');

    // Instructions in frontmatter
    expect(fileContent).toContain('instructions:');
    expect(fileContent).toContain('methodical code reviewer');

    // --- Markdown body (content → reference material) ---
    expect(fileContent).toContain('# Code Review Reference');
    expect(fileContent).toContain('OWASP Top 10');

    // --- V1 top-level fields should NOT be present on V2 agents ---
    // Note: riskTolerance also appears as a nested autonomy sub-field (valid V2),
    // so we check for it as a top-level YAML key (no leading whitespace).
    expect(fileContent).not.toContain('decisionFramework:');
    expect(fileContent).not.toMatch(/^riskTolerance:/m);
    expect(fileContent).not.toContain('learningEnabled:');
    expect(fileContent).not.toContain('maxConcurrentGoals:');
  });

  it('should return all V2 fields via get_element_details after creation', async () => {
    const createResult = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: V2_AGENT_PARAMS,
    });
    expect(createResult.success).toBe(true);

    await waitForCacheSettle();

    const detailsResult = await mcpAqlHandler.handleRead({
      operation: 'get_element_details',
      elementType: 'agent',
      params: { element_name: 'v2-roundtrip-agent' },
    });

    expect(detailsResult.success).toBe(true);
    const text = detailsResult.data?.content?.[0]?.text ?? '';

    // Goal configuration
    expect(text).toContain('Goal Configuration');
    expect(text).toContain('Review {files} for {review_type} issues');
    expect(text).toContain('files');
    expect(text).toContain('review_type');
    expect(text).toContain('Success Criteria');

    // Activates
    expect(text).toContain('Activates');
    expect(text).toContain('code-review');
    expect(text).toContain('security-audit');

    // Tools
    expect(text).toContain('Tools');
    expect(text).toContain('Allowed');
    expect(text).toContain('Denied');

    // System prompt
    expect(text).toContain('System Prompt');
    expect(text).toContain('automated code review agent');

    // Autonomy
    expect(text).toContain('Autonomy Configuration');
    expect(text).toContain('25'); // max autonomous steps

    // Resilience (Issue #722: now displayed in get_element_details)
    expect(text).toContain('Resilience Policy');
    expect(text).toContain('Max Retries: 3');
    expect(text).toContain('Max Continuations: 5');
    // Issue #749: retryBackoff and preserveState were missing from display
    expect(text).toContain('Retry Backoff: exponential');
    expect(text).toContain('Preserve State: true');

    // Tags & Triggers (Issue #722: now displayed in get_element_details)
    expect(text).toContain('Tags');
    expect(text).toContain('code-review');
    expect(text).toContain('Triggers');
    expect(text).toContain('review');

    // Instructions (behavioral directives)
    expect(text).toContain('Instructions');
    expect(text).toContain('methodical code reviewer');

    // Content (reference material)
    expect(text).toContain('Reference');
    expect(text).toContain('Code Review Reference');
  });

  it('should route content to markdown body and instructions to frontmatter (dual-field)', async () => {
    const createResult = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: V2_AGENT_PARAMS,
    });
    expect(createResult.success).toBe(true);

    const agentFile = path.join(env.testDir, 'agents', 'v2-roundtrip-agent.md');
    const fileContent = await fs.readFile(agentFile, 'utf-8');

    // Split frontmatter from body
    const parts = fileContent.split('---');
    expect(parts.length).toBeGreaterThanOrEqual(3); // ---, frontmatter, ---, body

    const frontmatter = parts[1];
    const body = parts.slice(2).join('---');

    // Instructions should be in frontmatter, NOT in body
    expect(frontmatter).toContain('instructions:');
    expect(frontmatter).toContain('methodical code reviewer');

    // Content should be in body (markdown), NOT in frontmatter as 'content:'
    expect(body).toContain('Code Review Reference');
    expect(body).toContain('OWASP Top 10');
  });

  it('should not bleed agent-specific fields into non-agent elements', async () => {
    // Create a skill with tags and triggers (common fields) but NOT agent-specific fields
    const skillResult = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'no-bleed-skill',
        element_type: 'skills',
        description: 'Skill that should not have agent fields',
        content: '# Clean Skill\n\nNo agent fields here.',
        tags: ['testing'],
        triggers: ['test'],
        // Agent fields intentionally omitted — verify they don't appear
      },
    });
    expect(skillResult.success).toBe(true);

    const skillFile = path.join(env.testDir, 'skills', 'no-bleed-skill.md');
    const fileContent = await fs.readFile(skillFile, 'utf-8');

    // Common fields SHOULD be present
    expect(fileContent).toContain('tags:');
    expect(fileContent).toContain('triggers:');

    // Agent-specific fields should NOT appear
    expect(fileContent).not.toContain('goal:');
    expect(fileContent).not.toContain('activates:');
    expect(fileContent).not.toContain('systemPrompt:');
    expect(fileContent).not.toContain('autonomy:');
    expect(fileContent).not.toContain('resilience:');
    expect(fileContent).not.toContain('decisionFramework:');
  });

  it('should create a minimal V2 agent with only goal (no optional V2 fields)', async () => {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'minimal-v2-agent',
        element_type: 'agents',
        description: 'Agent with only goal, no other V2 fields',
        instructions: 'Execute tasks efficiently.',
        goal: {
          template: 'Complete {task}',
          parameters: [{ name: 'task', type: 'string', required: true }],
        },
      },
    });

    expect(result.success).toBe(true);

    const agentFile = path.join(env.testDir, 'agents', 'minimal-v2-agent.md');
    const fileContent = await fs.readFile(agentFile, 'utf-8');

    // Goal should be present
    expect(fileContent).toContain('goal:');
    expect(fileContent).toContain('Complete {task}');

    // V1 defaults should NOT be present (has goal → is V2)
    expect(fileContent).not.toContain('decisionFramework:');
    expect(fileContent).not.toContain('riskTolerance:');
    expect(fileContent).not.toContain('learningEnabled:');

    // Optional V2 fields should NOT appear if not provided
    expect(fileContent).not.toContain('activates:');
    expect(fileContent).not.toContain('systemPrompt:');
    expect(fileContent).not.toContain('autonomy:');
    expect(fileContent).not.toContain('resilience:');
  });

  it('should create a V1 agent (no goal) and preserve V1 fields', async () => {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'legacy-v1-agent',
        element_type: 'agents',
        description: 'Agent without goal — V1 format',
        instructions: 'Handle tasks using rule-based decisions.',
      },
    });

    expect(result.success).toBe(true);

    const agentFile = path.join(env.testDir, 'agents', 'legacy-v1-agent.md');
    const fileContent = await fs.readFile(agentFile, 'utf-8');

    // V1 agents should have V1 fields (from constructor defaults)
    expect(fileContent).toContain('decisionFramework:');
    expect(fileContent).toContain('riskTolerance:');

    // Should NOT have V2-specific fields
    expect(fileContent).not.toContain('goal:');
    expect(fileContent).not.toContain('activates:');
    expect(fileContent).not.toContain('systemPrompt:');
  });

  it('should prefer metadata.tags over params.tags (metadata takes precedence)', async () => {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'precedence-agent',
        element_type: 'agents',
        description: 'Tests metadata vs params precedence',
        instructions: 'Test agent.',
        goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
        tags: ['from-params'],
        metadata: { tags: ['from-metadata'] },
      },
    });

    expect(result.success).toBe(true);

    const agentFile = path.join(env.testDir, 'agents', 'precedence-agent.md');
    const fileContent = await fs.readFile(agentFile, 'utf-8');

    // SchemaDispatcher only merges params.tags when metadata.tags is undefined,
    // so metadata.tags should win.
    expect(fileContent).toContain('from-metadata');
    expect(fileContent).not.toContain('from-params');
  });

  // Issue #727: Write-time validation via full MCP pipeline
  it('should reject creation with invalid V2 enum values', async () => {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'bad-enum-agent',
        element_type: 'agents',
        description: 'Agent with invalid enum values',
        instructions: 'Test instructions.',
        goal: {
          template: 'Do {task}',
          parameters: [{ name: 'task', type: 'string', required: true }],
        },
        autonomy: { riskTolerance: 'yolo' },
        resilience: { onStepLimitReached: 'explode' },
      },
    });

    // createElement returns {content, isError: true} which MCPAQLHandler wraps as success.
    // The error is surfaced via isError flag and the text content.
    const data = result.data as any;
    expect(data?.isError).toBe(true);
    const text = data?.content?.[0]?.text ?? '';
    expect(text).toMatch(/yolo|risk.?tolerance|explode|onStepLimitReached/i);
  });

  it('should normalize snake_case V2 fields and create successfully via MCP pipeline', async () => {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'snake-case-pipeline-agent',
        element_type: 'agents',
        description: 'Agent with snake_case V2 fields',
        instructions: 'Test instructions.',
        goal: {
          template: 'Do {task}',
          parameters: [{ name: 'task', type: 'string', required: true }],
        },
        autonomy: { risk_tolerance: 'conservative', max_autonomous_steps: 10 },
        resilience: { on_step_limit_reached: 'pause', retry_backoff: 'exponential' },
      },
    });

    expect(result.success).toBe(true);

    // Verify file has camelCase keys (normalized)
    const agentFile = path.join(env.testDir, 'agents', 'snake-case-pipeline-agent.md');
    const fileContent = await fs.readFile(agentFile, 'utf-8');
    expect(fileContent).toContain('riskTolerance:');
    expect(fileContent).toContain('conservative');
    expect(fileContent).toContain('onStepLimitReached:');
    expect(fileContent).toContain('pause');
    expect(fileContent).toContain('retryBackoff:');
    expect(fileContent).toContain('exponential');
  });
});
