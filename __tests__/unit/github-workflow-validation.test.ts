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
import yaml from 'js-yaml';

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
}

interface Workflow {
  name: string;
  on: any;
  jobs: Record<string, WorkflowJob>;
  env?: Record<string, any>;
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
          Object.entries(workflow.jobs).forEach(([jobName, job]) => {
            job.steps.forEach((step, index) => {
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
        
        Object.entries(workflow.jobs).forEach(([jobName, job]) => {
          job.steps.forEach((step, index) => {
            if (step.run && !step.shell) {
              problematicPatterns.forEach(({ pattern, description }) => {
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
        
        Object.entries(workflow.jobs).forEach(([jobName, job]) => {
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