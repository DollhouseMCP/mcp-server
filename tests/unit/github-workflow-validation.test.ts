/**
 * GitHub Workflow Validation Tests
 * 
 * These tests verify that our GitHub Actions workflows are properly
 * configured with the correct shell directives and environment variables.
 * This helps catch configuration issues before they cause CI failures.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface WorkflowStep {
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, any>;
  env?: Record<string, any>;
}

interface WorkflowJob {
  name?: string;
  'runs-on': string | string[];
  steps: WorkflowStep[];
  env?: Record<string, any>;
  permissions?: Record<string, string> | string;
  needs?: string | string[];
}

interface Workflow {
  name: string;
  on: any;
  jobs: Record<string, WorkflowJob>;
  env?: Record<string, any>;
  permissions?: Record<string, string> | string;
}

describe('GitHub Workflow Validation', () => {
  const workflowDir = path.join(process.cwd(), '.github', 'workflows');
  const workflowFiles = fs.existsSync(workflowDir) 
    ? fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];

  describe('Workflow Files', () => {
    it('should have workflow files', () => {
      expect(workflowFiles.length).toBeGreaterThan(0);
    });

    workflowFiles.forEach(file => {
      describe(`Workflow: ${file}`, () => {
        let workflow: Workflow;
        
        beforeAll(() => {
          const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
          workflow = yaml.load(content) as Workflow;
        });

        it('should have valid YAML structure', () => {
          expect(workflow).toBeDefined();
          expect(workflow.name).toBeDefined();
          expect(workflow.jobs).toBeDefined();
        });

        it('should have bash shell for cross-platform shell commands', () => {
          Object.entries(workflow.jobs).forEach(([_jobName, job]) => {
            job.steps.forEach((step, _index) => {
              // Check if step has shell commands that need bash
              if (step.run && needsBashShell(step.run)) {
                expect(step.shell).toBe('bash');
              }
            });
          });
        });

        it('should set TEST_PERSONAS_DIR for test jobs', () => {
          Object.entries(workflow.jobs).forEach(([jobName, job]) => {
            if (jobName.includes('test') || jobName.includes('Test')) {
              // Check if the job or its steps set TEST_PERSONAS_DIR
              // Also check workflow-level env
              const hasEnvVar = checkForTestPersonasDir(job) || !!workflow.env?.TEST_PERSONAS_DIR;
              
              // Only enforce for specific workflows that run tests
              if (file.includes('core-build-test') || file.includes('docker-testing')) {
                expect(hasEnvVar).toBe(true);
              }
            }
          });
        });

        it('should have proper permissions set', () => {
          // Check if workflow has permissions defined (for security)
          if (workflow.jobs) {
            Object.entries(workflow.jobs).forEach(([jobName, job]) => {
              // This is more of a warning than a hard requirement
              if (!job.permissions && !workflow.permissions) {
                console.warn(`Job ${jobName} in ${file} has no explicit permissions`);
              }
            });
          }
        });
      });
    });
  });

  describe('Shell Command Patterns', () => {
    const problematicPatterns = [
      { pattern: /\$\(pwd\)/, description: 'command substitution without shell directive' },
      { pattern: /2>\/dev\/null/, description: 'stderr redirection without shell directive' },
      { pattern: /\[\[.*\]\]/, description: 'bash conditionals without shell directive' },
      { pattern: /if \[.*\]; then/, description: 'bash if statements without shell directive' }
    ];

    workflowFiles.forEach(file => {
      it(`should not have problematic patterns without bash shell in ${file}`, () => {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const workflow = yaml.load(content) as Workflow;
        
        Object.entries(workflow.jobs).forEach(([_jobName, job]) => {
          job.steps.forEach((step, _index) => {
            if (step.run && !step.shell) {
              problematicPatterns.forEach(({ pattern, description: _description }) => {
                if (pattern.test(step.run!)) {
                  // This should fail - we need shell: bash for these patterns
                  expect(step.shell).toBe('bash');
                }
              });
            }
          });
        });
      });
    });
  });

  describe('Environment Variable Validation', () => {
    it('should use consistent environment variable patterns', () => {
      workflowFiles.forEach(file => {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const workflow = yaml.load(content) as Workflow;
        
        Object.entries(workflow.jobs).forEach(([_jobName, job]) => {
          // Check for TEST_PERSONAS_DIR usage
          if (job.env?.TEST_PERSONAS_DIR) {
            // Should use proper GitHub Actions syntax
            expect(job.env.TEST_PERSONAS_DIR).toMatch(/\$\{\{.*\}\}|[^$]/);
          }
          
          job.steps.forEach(step => {
            if (step.env?.TEST_PERSONAS_DIR) {
              expect(step.env.TEST_PERSONAS_DIR).toMatch(/\$\{\{.*\}\}|[^$]/);
            }
          });
        });
      });
    });
  });

  describe('Publish to MCP Registry Workflow', () => {
    let workflow: Workflow;
    let workflowContent: string;

    beforeAll(() => {
      const workflowPath = path.join(workflowDir, 'publish-mcp-registry.yml');
      workflowContent = fs.readFileSync(workflowPath, 'utf8');
      workflow = yaml.load(workflowContent) as Workflow;
    });

    it('should allow workflow_dispatch reruns against an explicit release ref', () => {
      const dispatchInputs = workflow.on?.workflow_dispatch?.inputs;

      expect(dispatchInputs?.release_ref).toBeDefined();
      expect(dispatchInputs?.release_ref.type).toBe('string');
      expect(dispatchInputs?.dry_run).toBeDefined();
    });

    it('should validate and normalize release refs before checkout', () => {
      const publishJob = workflow.jobs.publish;
      const resolveStep = publishJob.steps.find(step => step.name === 'Resolve and validate source ref');
      const checkoutStep = publishJob.steps.find(step => step.name === 'Checkout code');

      expect(resolveStep?.run).toContain("Unsupported release ref");
      expect(resolveStep?.run).toContain("refs/tags/");
      expect(resolveStep?.run).toContain("refs/heads/");
      expect(checkoutStep?.with?.ref).toBe('${{ steps.source-ref.outputs.ref }}');
    });

    it('should verify publisher downloads with pinned Sigstore bundle checks', () => {
      const publishJob = workflow.jobs.publish;
      const cosignStep = publishJob.steps.find(step => step.name === 'Install cosign');
      const downloadStep = publishJob.steps.find(step => step.name === 'Download mcp-publisher CLI');

      expect(cosignStep?.uses).toMatch(/^sigstore\/cosign-installer@[a-f0-9]{40}$/);
      expect(cosignStep?.with?.['cosign-release']).toBe('v3.0.6');
      expect(workflowContent).toContain('Pinned to cosign-installer v4.1.2');
      expect(workflowContent).toContain('https://github.com/sigstore/cosign-installer/issues/202');
      expect(downloadStep?.run).toContain('set -euo pipefail');
      expect(downloadStep?.run).toContain('VERSION="v1.7.9"');
      expect(downloadStep?.run).toContain('EXPECTED_SHA256="ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac"');
      expect(downloadStep?.run).toContain('.sigstore.json');
      expect(downloadStep?.run).toContain('SHA256 verification failed');
      expect(downloadStep?.run).toContain('cosign verify-blob');
      expect(downloadStep?.run).toContain('--bundle "$BUNDLE_FILE"');
      expect(downloadStep?.run).toContain('--certificate-identity "$EXPECTED_IDENTITY"');
      expect(downloadStep?.run).toContain('--certificate-oidc-issuer "$EXPECTED_ISSUER"');
      expect(downloadStep?.run).toContain('EXPECTED_ISSUER');
      expect(downloadStep?.run).toContain('https://token.actions.githubusercontent.com');
    });
  });

  describe('Publish to npm Workflow', () => {
    let workflow: Workflow;

    beforeAll(() => {
      const workflowPath = path.join(workflowDir, 'publish-npm.yml');
      workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as Workflow;
    });

    it('should publish the safety package before the server package', () => {
      const safetyJob = workflow.jobs['publish-safety'];
      const serverJob = workflow.jobs['publish-npm'];

      expect(safetyJob).toBeDefined();
      expect(serverJob.needs).toBe('publish-safety');
    });

    it('should scope OIDC write permission to each publishing job', () => {
      const expectedPermissions = { 'id-token': 'write', contents: 'read' };

      expect(workflow.permissions).toBeUndefined();
      expect(workflow.jobs['publish-safety'].permissions).toEqual(expectedPermissions);
      expect(workflow.jobs['publish-npm'].permissions).toEqual(expectedPermissions);
    });

    it('should fail closed when the safety dependency floor is mismatched', () => {
      const safetyJob = workflow.jobs['publish-safety'];
      const versionStep = safetyJob.steps.find(step => step.name === 'Check safety package version');

      expect(versionStep?.run).toContain("dependencies['@dollhousemcp/safety']");
      expect(versionStep?.run).toContain('EXPECTED_RANGE="^$VERSION"');
      expect(versionStep?.run).toContain('does not match the server dependency floor');
      expect(versionStep?.run).toMatch(/if \[ "\$REQUIRED_RANGE" != "\$EXPECTED_RANGE" \]; then[\s\S]*exit 1/);
    });

    it('should publish safety only after a verified registry absence', () => {
      const safetyJob = workflow.jobs['publish-safety'];
      const versionStep = safetyJob.steps.find(step => step.name === 'Check safety package version');
      const publishStep = safetyJob.steps.find(step => step.name === 'Publish safety package (with provenance)');

      expect(versionStep?.run).toContain('@dollhousemcp/safety@$VERSION');
      expect(versionStep?.run).toContain('for ATTEMPT in 1 2 3');
      expect(versionStep?.run).toContain('E404');
      expect(versionStep?.run).toContain('No match found for version');
      expect(versionStep?.run).toContain('sleep $((ATTEMPT * 2))');
      expect(versionStep?.run).toContain('after 3 attempts');
      expect(versionStep?.run).toContain('needs_publish=false');
      expect(versionStep?.run).toContain('needs_publish=true');
      expect(publishStep?.run).toBe('npm publish --provenance --access public --loglevel verbose');
      expect(publishStep?.env?.NPM_CONFIG_PROVENANCE).toBe('true');
    });

    it('should retain a safety-package dry run path', () => {
      const safetyJob = workflow.jobs['publish-safety'];
      const dryRunStep = safetyJob.steps.find(step => step.name === 'Dry run safety package');

      expect(dryRunStep?.shell).toBe('bash');
      expect(dryRunStep?.run).toContain('version=0.0.0-dry-run.${GITHUB_RUN_ID}');
      expect(dryRunStep?.run).toContain('npm publish --dry-run');
    });

    it('should avoid published-version conflicts in both dry-run paths', () => {
      const safetyDryRun = workflow.jobs['publish-safety'].steps.find(
        step => step.name === 'Dry run safety package'
      );
      const serverDryRun = workflow.jobs['publish-npm'].steps.find(
        step => step.name === 'Dry run (skip publish)'
      );

      for (const step of [safetyDryRun, serverDryRun]) {
        expect(step?.run).toContain('npm pkg set "version=0.0.0-dry-run.${GITHUB_RUN_ID}"');
        expect(step?.run).toContain('npm publish --dry-run');
      }
    });
  });
});

// Helper functions

function needsBashShell(command: string): boolean {
  const bashPatterns = [
    /\$\(.*\)/,          // Command substitution
    /2>\/dev\/null/,     // Stderr redirection
    /\[\[.*\]\]/,        // Bash conditionals
    /if \[.*\]; then/,   // Bash if statements
    /\|\|/,              // OR operator (when used with conditionals)
    /&&/,                // AND operator (when used with conditionals)
  ];
  
  return bashPatterns.some(pattern => pattern.test(command));
}

function checkForTestPersonasDir(job: WorkflowJob): boolean {
  // Check job-level env
  if (job.env?.TEST_PERSONAS_DIR) {
    return true;
  }
  
  // Check step-level env
  return job.steps.some(step => {
    if (step.env?.TEST_PERSONAS_DIR) {
      return true;
    }
    
    // Check if it's set in a run command
    if (step.run && step.run.includes('TEST_PERSONAS_DIR')) {
      return true;
    }
    
    return false;
  });
}
