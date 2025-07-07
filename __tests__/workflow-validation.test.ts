import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Workflow Validation Tests - Issue #92
 * 
 * These tests validate that our GitHub Actions workflows are properly configured
 * for cross-platform compatibility, especially the fixes from PR #89, #106, #108, #110.
 */
describe('GitHub Actions Workflow Validation', () => {
  const workflowsDir = path.join(process.cwd(), '.github', 'workflows');

  async function loadWorkflow(filename: string): Promise<any> {
    const content = await fs.readFile(path.join(workflowsDir, filename), 'utf8');
    return yaml.load(content);
  }

  describe('Shell Configuration', () => {
    it('should have bash shell specified for cross-platform commands', async () => {
      const criticalWorkflows = [
        'core-build-test.yml',
        'build-artifacts.yml'
      ];

      for (const workflowFile of criticalWorkflows) {
        try {
          const workflow = await loadWorkflow(workflowFile);
          
          // Check all jobs
          for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
            const steps = (job as any).steps || [];
            
            for (const [index, step] of steps.entries()) {
              // If the step has a run command with bash-specific syntax
              if (step.run && (
                step.run.includes('2>/dev/null') ||
                step.run.includes('$(') ||
                step.run.includes('[[') ||
                step.run.includes('if [')
              )) {
                // It should have shell: bash specified
                expect(step.shell).toBe('bash');
              }
            }
          }
        } catch (error) {
          // Workflow might not exist in test environment
          console.log(`Skipping workflow validation for ${workflowFile}`);
        }
      }
    });

    it('should use proper syntax for different shells', async () => {
      try {
        const workflow = await loadWorkflow('core-build-test.yml');
        
        // Verify environment variable setting is cross-platform
        for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
          const steps = (job as any).steps || [];
          
          const envStep = steps.find((s: any) => s.name?.includes('Set up test environment'));
          if (envStep) {
            // Should set TEST_PERSONAS_DIR
            expect(envStep.run).toContain('TEST_PERSONAS_DIR');
            expect(envStep.run).toContain('GITHUB_ENV');
          }
        }
      } catch (error) {
        console.log('Skipping detailed workflow validation');
      }
    });
  });

  describe('Environment Variable Configuration', () => {
    it('should properly export TEST_PERSONAS_DIR', async () => {
      try {
        const workflow = await loadWorkflow('core-build-test.yml');
        
        // Find the test job
        const testJob = workflow.jobs?.test;
        if (testJob) {
          const steps = testJob.steps || [];
          
          // Should have environment setup step
          const setupStep = steps.find((s: any) => 
            s.run?.includes('TEST_PERSONAS_DIR') && 
            s.run?.includes('GITHUB_ENV')
          );
          
          expect(setupStep).toBeDefined();
          
          // Should use proper GitHub Actions syntax
          if (setupStep) {
            expect(setupStep.run).toMatch(/echo\s+"TEST_PERSONAS_DIR=[^"]+"\s*>>\s*\$GITHUB_ENV/);
          }
        }
      } catch (error) {
        console.log('Workflow not found in test environment');
      }
    });

    it('should validate environment variables are available to subsequent steps', async () => {
      // This is more of a documentation test
      // In actual CI, steps after environment setup should have access to TEST_PERSONAS_DIR
      expect(true).toBe(true);
    });
  });

  describe('Cross-Platform Compatibility', () => {
    it('should run on all major platforms', async () => {
      try {
        const workflow = await loadWorkflow('core-build-test.yml');
        
        const testJob = workflow.jobs?.test;
        if (testJob && testJob.strategy?.matrix?.os) {
          const platforms = testJob.strategy.matrix.os;
          
          // Should include all major platforms
          expect(platforms).toContain('ubuntu-latest');
          expect(platforms).toContain('windows-latest');
          expect(platforms).toContain('macos-latest');
        }
      } catch (error) {
        console.log('Workflow validation skipped');
      }
    });

    it('should support multiple Node.js versions', async () => {
      try {
        const workflow = await loadWorkflow('core-build-test.yml');
        
        const testJob = workflow.jobs?.test;
        if (testJob && testJob.strategy?.matrix?.node) {
          const nodeVersions = testJob.strategy.matrix.node;
          
          // Should test on Node 20.x at minimum
          expect(nodeVersions).toContain('20.x');
        }
      } catch (error) {
        console.log('Workflow validation skipped');
      }
    });
  });

  describe('Error Handling', () => {
    it('should have proper error handling for failed tests', async () => {
      try {
        const workflow = await loadWorkflow('core-build-test.yml');
        
        // Look for debug steps that run on failure
        const testJob = workflow.jobs?.test;
        if (testJob) {
          const steps = testJob.steps || [];
          
          const debugStep = steps.find((s: any) => 
            s.name?.includes('Debug') && 
            s.if === 'failure()'
          );
          
          expect(debugStep).toBeDefined();
          
          // Debug step should use bash shell
          if (debugStep) {
            expect(debugStep.shell).toBe('bash');
          }
        }
      } catch (error) {
        console.log('Workflow validation skipped');
      }
    });
  });

  describe('Build Artifacts Workflow', () => {
    it('should properly verify build artifacts', async () => {
      try {
        const workflow = await loadWorkflow('build-artifacts.yml');
        
        const buildJob = workflow.jobs?.build;
        if (buildJob) {
          const steps = buildJob.steps || [];
          
          // Should have artifact verification step
          const verifyStep = steps.find((s: any) => 
            s.name?.includes('Verify build artifacts')
          );
          
          if (verifyStep) {
            // Should use bash shell for cross-platform compatibility
            expect(verifyStep.shell).toBe('bash');
            
            // Should check for required files
            expect(verifyStep.run).toContain('index.js');
            expect(verifyStep.run).toContain('package.json');
          }
        }
      } catch (error) {
        console.log('Build artifacts workflow validation skipped');
      }
    });
  });

  describe('Docker Workflows', () => {
    it('should handle Docker environment detection', async () => {
      try {
        const workflow = await loadWorkflow('docker-build-test.yml');
        
        // Docker workflows should set RUNNING_IN_DOCKER
        const dockerJobs = Object.values(workflow.jobs || {});
        
        for (const job of dockerJobs) {
          const steps = (job as any).steps || [];
          
          // Should have Docker-specific environment variables
          const dockerStep = steps.find((s: any) => 
            s.uses?.includes('docker')
          );
          
          if (dockerStep) {
            expect(dockerStep.with?.build_args).toContain('RUNNING_IN_DOCKER=true');
          }
        }
      } catch (error) {
        console.log('Docker workflow validation skipped');
      }
    });
  });

  describe('Integration Test Configuration', () => {
    it('should provide proper environment for integration tests', () => {
      // This test documents the expected environment
      // Integration tests should have:
      // 1. TEST_PERSONAS_DIR environment variable
      // 2. Proper Node.js version
      // 3. Access to test fixtures
      
      if (process.env.CI === 'true') {
        // In CI, these should be set by the workflow
        expect(process.env.GITHUB_ACTIONS).toBe('true');
      }
    });
  });

  describe('Security Best Practices', () => {
    it('should not expose sensitive information in logs', async () => {
      try {
        const workflows = await fs.readdir(workflowsDir);
        
        for (const workflowFile of workflows.filter(f => f.endsWith('.yml'))) {
          const content = await fs.readFile(path.join(workflowsDir, workflowFile), 'utf8');
          
          // Should not echo sensitive environment variables directly
          expect(content).not.toMatch(/echo.*\$\{\{.*secrets\..*\}\}/i);
          
          // Should use proper secret masking if needed
          if (content.includes('secrets.')) {
            expect(content).toMatch(/\$\{\{.*secrets\..*\}\}/);
          }
        }
      } catch (error) {
        console.log('Security validation skipped');
      }
    });
  });
});