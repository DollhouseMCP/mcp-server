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
  id?: string;
  if?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, any>;
  env?: Record<string, any>;
  'continue-on-error'?: boolean;
}

interface WorkflowService {
  image: string;
  env?: Record<string, any>;
  ports?: Array<string | number>;
  options?: string;
}

interface WorkflowJob {
  name?: string;
  'runs-on': string | string[];
  steps: WorkflowStep[];
  strategy?: {
    matrix?: {
      os?: string | string[];
    };
  };
  env?: Record<string, any>;
  permissions?: Record<string, string> | string;
  services?: Record<string, WorkflowService>;
  'timeout-minutes'?: number;
}

interface Workflow {
  name: string;
  on: any;
  jobs: Record<string, WorkflowJob>;
  env?: Record<string, any>;
  permissions?: Record<string, string> | string;
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: boolean;
  };
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

        it('should avoid write-all permissions and report missing explicit permissions', () => {
          const parsedJobs = (workflow as Partial<Workflow>).jobs;
          expect(parsedJobs).toBeDefined();

          Object.entries(parsedJobs ?? {}).forEach(([jobName, job]) => {
            const effectivePermissions = job.permissions ?? workflow.permissions;
            expect(effectivePermissions).not.toBe('write-all');
            if (!effectivePermissions) {
              console.warn(`Job ${jobName} in ${file} has no explicit permissions`);
            }
          });
        });
      });
    });
  });

  describe('Beta CI policy', () => {
    const hostedBranch = 'codex/hosted-http-integration';
    const requiredPushWorkflows = [
      'build-artifacts.yml',
      'codeql.yml',
      'core-build-test.yml',
      'docker-testing.yml',
    ];
    const requiredPullRequestWorkflows = [
      'build-artifacts.yml',
      'codeql.yml',
      'core-build-test.yml',
      'docker-testing.yml',
    ];
    it.each(requiredPushWorkflows)(
      'should not retain the retired hosted branch push trigger in %s',
      (file) => {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const workflow = yaml.load(content) as Workflow;

        expect(workflow.on?.push?.branches).not.toContain(hostedBranch);
      }
    );

    it.each(requiredPullRequestWorkflows)(
      'should not retain the retired hosted branch pull-request trigger in %s',
      (file) => {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const workflow = yaml.load(content) as Workflow;

        expect(workflow.on?.pull_request?.branches).not.toContain(hostedBranch);
      }
    );

    it('should enforce unit tests and report performance tests on every core platform', () => {
      const content = fs.readFileSync(
        path.join(workflowDir, 'core-build-test.yml'),
        'utf8'
      );
      const workflow = yaml.load(content) as Workflow;
      const steps = workflow.jobs['hosted-test'].steps;
      const operatingSystems = workflow.jobs['hosted-test'].strategy?.matrix?.os;
      const unitTestGate = steps.find(
        (step) => step.name === 'Enforce unit test result'
      );
      const performanceTests = steps.find(
        (step) => step.id === 'performance_tests'
      );
      const performanceTestGate = steps.find(
        (step) => step.name === 'Enforce performance test result'
      );

      expect(unitTestGate?.if).toBe('always()');
      expect(unitTestGate?.env?.TEST_OUTCOME).toBe(
        '${{ steps.original_tests.outcome }}'
      );
      expect(unitTestGate?.run).toContain('exit 1');
      expect(performanceTests?.if).toBeUndefined();
      expect(performanceTests?.['continue-on-error']).toBe(true);
      expect(performanceTestGate).toBeUndefined();
      expect(operatingSystems).toEqual([
        'ubuntu-latest',
        'windows-latest',
        'macos-latest',
      ]);
      expect(steps).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ if: false })])
      );
    });

    it('pins every external action in the primary hosted matrix', () => {
      const workflow = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'core-build-test.yml'), 'utf8')
      ) as Workflow;
      const externalActions = workflow.jobs['hosted-test'].steps
        .map((step) => step.uses)
        .filter((uses): uses is string => Boolean(uses));

      expect(externalActions).not.toHaveLength(0);
      for (const action of externalActions) {
        expect(action).toMatch(/^[^@]+@[a-f0-9]{40}$/);
      }
    });

    it('builds package artifacts from a clean dist tree', () => {
      const workflow = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'build-artifacts.yml'), 'utf8')
      ) as Workflow;
      const steps = workflow.jobs['build-artifacts'].steps;
      const buildCache = steps.find((step) => step.name === 'Cache TypeScript build');
      const build = steps.find((step) => step.name === 'Build project');

      expect(buildCache).toBeUndefined();
      expect(build?.run).toBe('npm run rebuild');
    });

    it('should enforce the full PostgreSQL integration suite against a pinned service', () => {
      const workflow = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'core-build-test.yml'), 'utf8')
      ) as Workflow;
      const job = workflow.jobs['postgres-integration'];
      const postgres = job?.services?.postgres;
      const integrationStep = job?.steps.find(
        (step) => step.name === 'Run required PostgreSQL integration suite'
      );
      const buildStepIndex = job?.steps.findIndex(
        (step) => step.name === 'Build project'
      ) ?? -1;
      const integrationStepIndex = job?.steps.findIndex(
        (step) => step.name === 'Run required PostgreSQL integration suite'
      ) ?? -1;

      expect(job?.name).toBe('PostgreSQL Integration');
      expect(job?.['runs-on']).toBe('ubuntu-latest');
      expect(job?.['timeout-minutes']).toBe(30);
      expect(job?.permissions).toEqual({ contents: 'read' });
      expect(job?.env?.DOLLHOUSE_REQUIRE_TEST_DATABASE).toBe('1');
      expect(job?.env?.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS).toBe('1');
      expect(job?.env?.DOLLHOUSE_TEST_DATABASE_URL).toBe(
        'postgres://dollhouse_app@localhost:5432/dollhousemcp_test'
      );
      expect(job?.env?.DOLLHOUSE_TEST_DATABASE_ADMIN_URL).toBe(
        'postgres://dollhouse@localhost:5432/dollhousemcp_test'
      );
      expect(job?.env?.TEST_PERSONAS_DIR).toBe('${{ github.workspace }}/test-personas');
      expect(buildStepIndex).toBeGreaterThan(-1);
      expect(job?.steps[buildStepIndex]?.run).toBe('npm run build');
      expect(buildStepIndex).toBeLessThan(integrationStepIndex);
      expect(postgres?.image).toBe(
        'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
      );
      expect(postgres?.env).toEqual({
        POSTGRES_USER: 'dollhouse',
        POSTGRES_HOST_AUTH_METHOD: 'trust',
        POSTGRES_DB: 'postgres',
      });
      expect(postgres?.ports).toEqual(['5432:5432']);
      expect(integrationStep?.run).toBe('npm run test:integration -- --runInBand');

      const externalActions = job?.steps
        .map((step) => step.uses)
        .filter((uses): uses is string => Boolean(uses));
      expect(externalActions).toEqual([
        'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
        'actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af',
      ]);
    });

    it('should hard-fail integration setup when PostgreSQL is required', () => {
      const setup = fs.readFileSync(path.join(process.cwd(), 'tests', 'setup.ts'), 'utf8');

      expect(setup).toContain("process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1'");
      expect(setup).toContain('throw new Error(`Required PostgreSQL integration setup failed: ${msg}`');
    });

    it('should give core and extended compatibility checks distinct names', () => {
      const core = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'core-build-test.yml'), 'utf8')
      ) as Workflow;
      const extended = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'extended-node-compatibility.yml'), 'utf8')
      ) as Workflow;

      expect(core.jobs['hosted-test'].name).toContain('Test (');
      expect(extended.jobs['extended-compatibility'].name).toContain('Extended (');
      expect(core.jobs['hosted-test'].name).not.toBe(
        extended.jobs['extended-compatibility'].name
      );
    });

    it('should require successful MCP payloads from every Docker gate', () => {
      const content = fs.readFileSync(
        path.join(workflowDir, 'docker-testing.yml'),
        'utf8'
      );
      const failureMessages = [
        'MCP initialize response is missing expected serverInfo',
        'tools/list response does not contain a non-empty result.tools array',
        'Docker Compose initialize response is missing expected serverInfo',
      ];

      for (const message of failureMessages) {
        const marker = content.indexOf(message);

        expect(marker).toBeGreaterThanOrEqual(0);
        expect(content.slice(marker, marker + 200)).toContain('exit 1');
      }

      expect(content).toContain('notifications/initialized');
      expect(content).toContain(".result.tools | type == \"array\" and length > 0");
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
                if (pattern.test(step.run)) {
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

        if (workflow.env?.TEST_PERSONAS_DIR) {
          expect(workflow.env.TEST_PERSONAS_DIR).toBe('${{ github.workspace }}/test-personas');
        }
        
        Object.entries(workflow.jobs).forEach(([_jobName, job]) => {
          if (job.env?.TEST_PERSONAS_DIR) {
            expect(job.env.TEST_PERSONAS_DIR).toBe('${{ github.workspace }}/test-personas');
          }
          
          job.steps.forEach(step => {
            if (step.env?.TEST_PERSONAS_DIR) {
              expect(step.env.TEST_PERSONAS_DIR).toBe('${{ github.workspace }}/test-personas');
            }
          });
        });
      });
    });

    it('clears every GitHub token alias from spawned test servers', () => {
      const spawnedServerTests = [
        'tests/integration/mcp-protocol-compliance.test.ts',
        'tests/integration/console-lifecycle.test.ts',
        'tests/integration/startup/startup-readiness.test.ts',
        'tests/integration/web-console-e2e/setup/provision.ts',
        'tests/integration/web-console-e2e/setup/globalSetup.ts',
        'tests/integration/database/mcp-database-e2e.test.ts',
        'tests/integration/database/http-database-e2e.test.ts',
        'tests/integration/database/auth-identity-e2e.test.ts',
        'tests/integration/mcp-aql/addentry-transport.test.ts',
        'tests/unit/scripts/qa-mcp-mode-contract.test.ts',
        'tests/todd/mcp-protocol-smoke.test.ts',
      ];

      for (const relativePath of spawnedServerTests) {
        const content = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
        expect(content).toContain("GITHUB_TOKEN: ''");
        expect(content).toContain("GITHUB_TEST_TOKEN: ''");
        expect(content).toContain("TEST_GITHUB_TOKEN: ''");
      }
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

  describe('Beta prerelease workflow channels', () => {
    it('should route exact beta and numbered beta versions to the beta npm dist-tag', () => {
      const npmWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-npm.yml'), 'utf8');
      const packagesWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-github-packages.yml'), 'utf8');

      expect(npmWorkflow).toContain('*-beta|*-beta.*)');
      expect(packagesWorkflow).toContain('*-beta|*-beta.*)');
    });

    it('should allow exact beta and numbered beta versions in beta CD workflows', () => {
      const betaPublishWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-beta-release.yml'), 'utf8');
      const betaDeployWorkflow = fs.readFileSync(path.join(workflowDir, 'deploy-beta-alpha-vps.yml'), 'utf8');

      expect(betaPublishWorkflow).toContain(String.raw`-beta(\.[0-9A-Za-z.-]+)?$`);
      expect(betaDeployWorkflow).toContain(String.raw`-beta(\.[0-9A-Za-z.-]+)?$`);
    });

    it('should dispatch and await every beta artifact publisher at the release tag', () => {
      const betaPublishWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-beta-release.yml'), 'utf8');

      expect(betaPublishWorkflow).toContain('actions: write');
      expect(betaPublishWorkflow).toContain('dispatch_and_capture publish-npm.yml');
      expect(betaPublishWorkflow).toContain('dispatch_and_capture publish-github-packages.yml');
      expect(betaPublishWorkflow).toContain('dispatch_and_capture publish-mcpb.yml');
      expect(betaPublishWorkflow).toContain('gh workflow run "${workflow}" --ref "${TAG_NAME}"');
      expect(betaPublishWorkflow).toContain('--field tag_name="${TAG_NAME}"');
      expect(betaPublishWorkflow).toContain('gh run list');
      expect(betaPublishWorkflow).toContain('gh run watch "${run_id}" --exit-status');
      expect(betaPublishWorkflow).toContain('publisher_run_ids=()');
      expect(betaPublishWorkflow).toContain('publisher_run_ids+=("${npm_run_id}")');
      expect(betaPublishWorkflow).toContain('publisher_run_ids+=("${packages_run_id}" "${mcpb_run_id}")');
    });

    it('should reuse only a matching published prerelease and safely retry publishers', () => {
      const betaPublishWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-beta-release.yml'), 'utf8');

      expect(betaPublishWorkflow).toContain('refs/tags/${tag_name}^{}');
      expect(betaPublishWorkflow).toContain('[[ "${remote_tag_target}" != "${GITHUB_SHA}" ]]');
      expect(betaPublishWorkflow).toContain('echo "tag_exists=${tag_exists}"');
      expect(betaPublishWorkflow).toContain('--json tagName,isPrerelease,isDraft,targetCommitish');
      expect(betaPublishWorkflow).toContain('[[ "${release_prerelease}" != "true" || "${release_draft}" != "false" ]]');
      expect(betaPublishWorkflow).toContain('[[ "${release_target}" != "${GITHUB_SHA}" ]]');
      expect(betaPublishWorkflow).toContain('::warning::Release ${tag_name} records a different targetCommitish');
      expect(betaPublishWorkflow).not.toContain('::error::Release ${tag_name} targets');
      expect(betaPublishWorkflow).toContain('echo "release_exists=${release_exists}"');
      expect(betaPublishWorkflow).toContain('echo "npm_publish_complete=${npm_publish_complete}"');
      expect(betaPublishWorkflow).toContain('beta_is_newer()');
      expect(betaPublishWorkflow).not.toContain('import semver from');
      expect(betaPublishWorkflow).toContain('} >> "$GITHUB_OUTPUT"');
      expect(betaPublishWorkflow).toContain('TAG_EXISTS: ${{ steps.release.outputs.tag_exists }}');
      expect(betaPublishWorkflow).toContain('RELEASE_EXISTS: ${{ steps.release.outputs.release_exists }}');
      expect(betaPublishWorkflow).toContain('if [[ "${TAG_EXISTS}" != "true" ]]');
      expect(betaPublishWorkflow).toContain('if [[ "${RELEASE_EXISTS}" != "true" ]]');
      expect(betaPublishWorkflow).toContain('gh release create "${TAG_NAME}"');
      expect(betaPublishWorkflow).toContain('NPM_PUBLISH_COMPLETE: ${{ steps.release.outputs.npm_publish_complete }}');
      expect(betaPublishWorkflow).toContain('if [[ "${NPM_PUBLISH_COMPLETE}" != "true" ]]');
      expect(betaPublishWorkflow).toContain('publisher_run_ids+=("${packages_run_id}" "${mcpb_run_id}")');
    });
  });

  describe('Claude review head integrity', () => {
    let workflow: Workflow;

    beforeAll(() => {
      const workflowPath = path.join(workflowDir, 'claude-code-review.yml');
      workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as Workflow;
    });

    it('does not advertise an unusable manual dispatch route', () => {
      expect(workflow.on?.workflow_dispatch).toBeUndefined();
    });

    it('cancels superseded reviews for the same pull request', () => {
      expect(workflow.concurrency?.group).toContain('github.event.pull_request.number');
      expect(workflow.concurrency?.['cancel-in-progress']).toBe(true);
    });

    it('checks out and verifies the exact pull-request head', () => {
      const steps = workflow.jobs['claude-review'].steps;
      const checkout = steps.find(step => step.name === 'Checkout repository');
      const verifyCheckout = steps.find(step => step.name === 'Verify checked out PR head');

      expect(checkout?.uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
      expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha }}');
      expect(checkout?.with?.['fetch-depth']).toBe(0);
      expect(checkout?.with?.['persist-credentials']).toBe(false);
      expect(workflow.jobs['claude-review'].permissions?.['id-token']).toBeUndefined();
      expect(verifyCheckout?.run).toContain('git rev-parse HEAD');
      expect(verifyCheckout?.run).toContain("--jq '.head.sha'");
      expect(verifyCheckout?.run).toContain('EXPECTED_HEAD_SHA');
    });

    it('binds the review prompt and completion check to the same head', () => {
      const steps = workflow.jobs['claude-review'].steps;
      const review = steps.find(step => step.name === 'Run Claude Code Review');
      const verifyCurrent = steps.find(step => step.name === 'Verify PR head remained current');
      const prompt = String(review?.with?.direct_prompt ?? '');

      expect(prompt).toContain('github.event.pull_request.head.sha');
      expect(prompt).toContain('**Reviewed commit:**');
      expect(verifyCurrent?.run).toContain("--jq '.head.sha'");
      expect(verifyCurrent?.run).toContain('PR head moved');
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
    if (step.run?.includes('TEST_PERSONAS_DIR')) {
      return true;
    }
    
    return false;
  });
}
