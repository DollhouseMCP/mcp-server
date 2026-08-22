/**
 * GitHub Workflow Validation Tests
 * 
 * These tests verify that our GitHub Actions workflows are properly
 * configured with the correct shell directives and environment variables.
 * This helps catch configuration issues before they cause CI failures.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'node:os';
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

interface WorkflowJob {
  name?: string;
  if?: string;
  'runs-on'?: string | string[];
  steps?: WorkflowStep[];
  uses?: string;
  needs?: string | string[];
  with?: Record<string, any>;
  strategy?: {
    matrix?: {
      os?: string | string[];
    };
  };
  env?: Record<string, any>;
  permissions?: Record<string, string> | string;
  environment?: string | { name?: string; url?: string };
  'timeout-minutes'?: number;
  services?: Record<string, {
    image?: string;
    env?: Record<string, string>;
    ports?: Array<string | number>;
    options?: string;
  }>;
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
            (job.steps ?? []).forEach((step, _index) => {
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

  describe('Hosted HTTP integration branch gate', () => {
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
    const deferredWorkflows = [
      { file: 'extended-node-compatibility.yml', events: ['push', 'pull_request'] },
      { file: 'qa-tests.yml', events: ['pull_request'] },
      { file: 'safety-package-check.yml', events: ['pull_request'] },
      { file: 'security-audit.yml', events: ['push', 'pull_request'] },
    ];

    it.each(requiredPushWorkflows)(
      'should run %s for pushes to the hosted branch',
      (file) => {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const workflow = yaml.load(content) as Workflow;

        expect(workflow.on?.push?.branches).toContain(hostedBranch);
      }
    );

    it.each(requiredPullRequestWorkflows)(
      'should run %s for pull requests targeting the hosted branch',
      (file) => {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const workflow = yaml.load(content) as Workflow;

        expect(workflow.on?.pull_request?.branches).toContain(hostedBranch);
      }
    );

    it.each(deferredWorkflows)(
      'should defer $file from the hosted integration gate',
      ({ file, events }) => {
        const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const workflow = yaml.load(content) as Workflow;

        for (const event of events) {
          expect(workflow.on?.[event]?.branches).not.toContain(hostedBranch);
        }
      }
    );

    it('should enforce unit tests on every core platform and defer performance at the hosted stage', () => {
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

      expect(unitTestGate?.if).toBe('always()');
      expect(unitTestGate?.env?.TEST_OUTCOME).toBe(
        '${{ steps.original_tests.outcome }}'
      );
      expect(unitTestGate?.run).toContain('exit 1');
      expect(performanceTests?.if).toContain(hostedBranch);
      expect(performanceTests?.['continue-on-error']).not.toBe(true);
      expect(operatingSystems).toEqual(expect.stringContaining(hostedBranch));
      expect(operatingSystems).toEqual(expect.stringContaining('["ubuntu-latest"]'));
      expect(steps).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ if: false })])
      );
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

    it('should require PostgreSQL migrations and database parity coverage', () => {
      const core = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'core-build-test.yml'), 'utf8')
      ) as Workflow;
      const job = core.jobs['postgres-integration'];
      const postgres = job.services?.postgres;
      const parityStep = job.steps?.find(
        (step) => step.name === 'Apply migrations and run PostgreSQL parity coverage'
      );

      expect(job.name).toBe('PostgreSQL Migration & Parity');
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBe(20);
      expect(job.permissions).toEqual({ contents: 'read' });
      expect(job.env?.DOLLHOUSE_REQUIRE_TEST_DATABASE).toBe('1');
      expect(job.env?.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS).toBe('1');
      expect(job.env?.TEST_PERSONAS_DIR).toBe('${{ github.workspace }}/test-personas');

      const compose = yaml.load(
        fs.readFileSync(path.join(process.cwd(), 'docker', 'docker-compose.db.yml'), 'utf8')
      ) as { services: { postgres: { image: string } } };
      expect(postgres?.image).toBe(
        `${compose.services.postgres.image}@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`,
      );
      expect(postgres?.env).toEqual({
        POSTGRES_USER: 'dollhouse',
        POSTGRES_PASSWORD: 'dollhouse',
        POSTGRES_DB: 'postgres',
      });
      expect(postgres?.ports).toContain('5432:5432');
      expect(postgres?.options).toContain('pg_isready -U dollhouse -d postgres');

      expect(parityStep?.['continue-on-error']).not.toBe(true);
      expect(parityStep?.run).toContain('npm run test:integration -- --runInBand');
      expect(parityStep?.run).toContain('tests/integration/database');
      expect(parityStep?.run).toContain('tests/integration/auth/storage-parity.test.ts');
      expect(parityStep?.run).toContain('tests/integration/storage');
      expect(parityStep?.run).toContain('tests/integration/agents/AgentManager.dbState.test.ts');

      const externalActions = (job.steps ?? [])
        .map((step) => step.uses)
        .filter((uses): uses is string => Boolean(uses));
      expect(externalActions).toEqual([
        'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
        'actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af',
      ]);
    });

    it('should hard-fail integration setup when CI requires PostgreSQL', () => {
      const setup = fs.readFileSync(path.join(process.cwd(), 'tests', 'setup.ts'), 'utf8');

      expect(setup).toContain("process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1'");
      expect(setup).toContain('throw new Error(`Required PostgreSQL integration setup failed: ${msg}`');
    });

    it('should run the real permission hook Docker integration in CI', () => {
      const docker = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'docker-testing.yml'), 'utf8')
      ) as Workflow;
      const job = docker.jobs['permission-hook-integration'];
      const integrationStep = job.steps?.find(
        (step) => step.name === 'Run permission hook Docker integration'
      );
      const dockerPreflight = job.steps?.find(
        (step) => step.name === 'Verify Docker daemon'
      );

      expect(job.name).toBe('Permission Hook Docker Integration');
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBe(15);
      expect(job.permissions).toEqual({ contents: 'read' });
      expect(job.env?.DOCKER_AVAILABLE).toBe('true');
      expect(job.env?.TEST_PERSONAS_DIR).toBe('${{ github.workspace }}/test-personas');
      expect(dockerPreflight?.run).toBe('docker info');
      expect(dockerPreflight?.['continue-on-error']).not.toBe(true);
      expect(integrationStep?.['continue-on-error']).not.toBe(true);
      expect(integrationStep?.run).toBe(
        'npm run test:integration:hooks:docker -- --runInBand'
      );

      const externalActions = (job.steps ?? [])
        .map((step) => step.uses)
        .filter((uses): uses is string => Boolean(uses));
      expect(externalActions).toEqual([
        'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
        'actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af',
      ]);
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
          (job.steps ?? []).forEach((step, _index) => {
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
          
          (job.steps ?? []).forEach(step => {
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

    it('should require a matching published stable tag for every live registry publication', () => {
      const publishJob = workflow.jobs.publish;
      const verifyStep = publishJob.steps.find(step => step.name === 'Verify immutable live release source');

      expect(verifyStep?.if).toContain("github.event.inputs.dry_run != 'true'");
      expect(verifyStep?.run).toContain('SOURCE_REF');
      expect(verifyStep?.run).toContain('refs/tags/${EXPECTED_TAG}');
      expect(verifyStep?.run).toContain('refs/tags/${EXPECTED_TAG}^{commit}');
      expect(verifyStep?.run).toContain('gh release view "${EXPECTED_TAG}"');
      expect(verifyStep?.run).toContain('isDraft');
      expect(verifyStep?.run).toContain('isPrerelease');
      expect(verifyStep?.run).toContain('targetCommitish');
      expect(verifyStep?.run).not.toContain('GITHUB_REF');
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

    it('should enforce strict beta SemVer in the reusable beta publisher', () => {
      const betaPublishWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-beta-release.yml'), 'utf8');

      expect(betaPublishWorkflow).toContain('node scripts/compare-semver.mjs --validate-beta');
      expect(betaPublishWorkflow).toContain('node scripts/compare-semver.mjs --validate-stable');
      expect(betaPublishWorkflow).not.toContain('-beta(\\.[0-9A-Za-z.-]+)?$');
    });

    it('should prepare a reusable publisher and its default-branch dispatcher', () => {
      const reusableContent = fs.readFileSync(path.join(workflowDir, 'publish-beta-release.yml'), 'utf8');
      const dispatcherContent = fs.readFileSync(path.join(workflowDir, 'publish-beta.yml'), 'utf8');
      const guideContent = fs.readFileSync(
        path.join(process.cwd(), 'docs/developer-guide/beta-release-cd.md'),
        'utf8',
      );
      const reusable = yaml.load(reusableContent) as Workflow;
      const dispatcher = yaml.load(dispatcherContent) as Workflow;

      expect(reusable.on?.workflow_call?.inputs?.source_ref?.required).toBe(true);
      expect(reusable.on?.workflow_dispatch).toBeUndefined();
      expect(dispatcher.on?.workflow_dispatch?.inputs?.version?.required).toBe(true);
      expect(dispatcher.on?.workflow_dispatch?.inputs?.dry_run?.default).toBe(true);
      expect(dispatcher.jobs.publish.if).toBe("github.ref == 'refs/heads/main'");
      expect(dispatcher.jobs.publish.uses).toBe('./.github/workflows/publish-beta-release.yml');
      expect(dispatcher.jobs.publish.with).toMatchObject({ source_ref: 'beta' });
      expect(reusable.jobs['publish-beta'].steps?.find(step => step.name === 'Checkout beta branch')?.with?.ref)
        .toBe('${{ inputs.source_ref }}');
      expect(reusableContent).toContain('SOURCE_REF: ${{ inputs.source_ref }}');
      expect(reusableContent).toContain('SOURCE_SHA: ${{ steps.source.outputs.sha }}');
      expect(guideContent).toContain('both reviewed\n> workflow files must reach `main`');
      expect(guideContent).toContain('uses: ./.github/workflows/publish-beta-release.yml');
      expect(guideContent).toContain('Never call mutable\n> `@main` or `@beta` workflow code');
      expect(guideContent).toContain('source_ref: beta');
    });

    it('should validate beta deployment tags with the shared strict parser', () => {
      const betaDeployWorkflow = fs.readFileSync(path.join(workflowDir, 'deploy-beta-alpha-vps.yml'), 'utf8');

      expect(betaDeployWorkflow).toContain(
        'node scripts/compare-semver.mjs --validate-beta "${INPUT_GIT_REF#v}"',
      );
      expect(betaDeployWorkflow).not.toContain('-beta(\\.[0-9A-Za-z.-]+)?$');
    });

    it('should dispatch and await every beta artifact publisher at the release tag', () => {
      const betaPublishWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-beta-release.yml'), 'utf8');

      expect(betaPublishWorkflow).toContain('actions: write');
      expect(betaPublishWorkflow).toContain('dispatch_and_capture publish-npm.yml');
      expect(betaPublishWorkflow).toContain('dispatch_and_capture publish-github-packages.yml');
      expect(betaPublishWorkflow).toContain('dispatch_and_capture publish-mcpb.yml');
      expect(betaPublishWorkflow).toContain('gh workflow run "${workflow}" --ref "${TAG_NAME}"');
      expect(betaPublishWorkflow).toContain('--field tag_name="${TAG_NAME}"');
      expect(betaPublishWorkflow).toContain('--field correlation_id="${correlation_id}"');
      expect(betaPublishWorkflow).toContain('--json databaseId,headSha,displayTitle');
      expect(betaPublishWorkflow).toContain('contains(\\"${correlation_id}\\")');
      expect(betaPublishWorkflow).toContain('gh run list');
      expect(betaPublishWorkflow).toContain('gh run watch "${run_id}" --exit-status');
      expect(betaPublishWorkflow).toContain('publisher_run_ids=()');
      expect(betaPublishWorkflow).toContain('publisher_run_ids+=("${npm_run_id}")');
      expect(betaPublishWorkflow).toContain('publisher_run_ids+=("${packages_run_id}" "${mcpb_run_id}")');
    });

    it('should make manual publication dry by default and verify live immutable tag sources', () => {
      for (const workflowName of ['publish-npm.yml', 'publish-github-packages.yml']) {
        const content = fs.readFileSync(path.join(workflowDir, workflowName), 'utf8');
        const parsed = yaml.load(content) as Workflow;
        expect(parsed.on?.workflow_dispatch?.inputs?.dry_run?.default).toBe(true);
        expect(content).toContain('Verify immutable release source');
        expect(content).toContain('refs/tags/${EXPECTED_TAG}^{commit}');
        expect(content).toContain('--json tagName,isDraft,isPrerelease');
        expect(content).toContain('VERSION_IS_PRERELEASE');
        expect(content).toContain('correlation_id');
      }
      const mcpb = fs.readFileSync(path.join(workflowDir, 'publish-mcpb.yml'), 'utf8');
      expect(mcpb).toContain('Verify immutable release source');
      expect(mcpb).toContain('refs/tags/${TAG_NAME}^{commit}');
      expect(mcpb).toContain('correlation_id');
    });

    it('should classify GitHub Packages lookups by status and exact stdout', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-github-packages.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const checkStep = workflow.jobs['publish-gpr'].steps?.find(
        step => step.name === 'Check if version already published',
      );
      const script = checkStep?.run;
      expect(script).toBeDefined();
      expect(script?.match(/npm view/gu)).toHaveLength(1);
      expect(script).toContain('NPM_VIEW_STATUS=$?');
      expect(script).toContain('[[ "$PUBLISHED_VERSION" != "$PACKAGE_VERSION" ]]');
      expect(script).toContain('E404');
      expect(script).not.toContain('2>&1 | grep');

      const version = '2.1.0-beta.9';
      const scenarios = [
        {
          label: 'published exact version',
          status: 0,
          stdout: `  ${version}\n`,
          stderr: '',
          expectedStatus: 0,
          expectedOutput: 'already_published=true',
        },
        {
          label: '404 repeats requested version',
          status: 1,
          stdout: '',
          stderr: `npm error code E404\nnpm error 404 ${version} is not in this registry`,
          expectedStatus: 0,
          expectedOutput: 'already_published=false',
        },
        {
          label: 'authentication failure',
          status: 1,
          stdout: '',
          stderr: 'npm error code E401\nnpm error authentication required',
          expectedStatus: 1,
          expectedOutput: null,
        },
        {
          label: 'successful lookup returns a different version',
          status: 0,
          stdout: '2.1.0-beta.8',
          stderr: '',
          expectedStatus: 1,
          expectedOutput: null,
        },
      ] as const;

      for (const scenario of scenarios) {
        const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-gpr-check-'));
        const binaryDirectory = path.join(temporaryDirectory, 'bin');
        const npmPath = path.join(binaryDirectory, 'npm');
        const outputPath = path.join(temporaryDirectory, 'github-output');
        const packagePath = path.join(temporaryDirectory, 'package.json');
        fs.mkdirSync(binaryDirectory);
        fs.writeFileSync(packagePath, JSON.stringify({ version }), 'utf8');
        fs.writeFileSync(npmPath, [
          '#!/usr/bin/env bash',
          'printf \'%s\' "${FAKE_NPM_STDOUT-}"',
          'printf \'%s\' "${FAKE_NPM_STDERR-}" >&2',
          'exit "${FAKE_NPM_STATUS:-0}"',
          '',
        ].join('\n'), 'utf8');
        fs.chmodSync(npmPath, 0o755);

        try {
          const result = spawnSync('bash', ['-c', script ?? 'exit 99'], {
            cwd: temporaryDirectory,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
              RUNNER_TEMP: temporaryDirectory,
              GITHUB_OUTPUT: outputPath,
              FAKE_NPM_STATUS: String(scenario.status),
              FAKE_NPM_STDOUT: scenario.stdout,
              FAKE_NPM_STDERR: scenario.stderr,
            },
          });
          expect(result.status).toBe(scenario.expectedStatus);
          const actionOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : null;
          expect(actionOutput).toBe(scenario.expectedOutput);
        } finally {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          fs.unlinkSync(npmPath);
          fs.unlinkSync(packagePath);
          fs.rmdirSync(binaryDirectory);
          fs.rmdirSync(temporaryDirectory);
        }
      }
    });

    it('should never move an existing GitHub Packages channel backward or mutate it in dry-run mode', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-github-packages.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const publishJob = workflow.jobs['publish-gpr'];
      const protectedChannelStep = publishJob.steps.find(
        step => step.name === 'Resolve protected channel publication mode',
      );
      const publishStep = publishJob.steps.find(step => step.name === 'Publish to GitHub Packages');
      const reconcileStep = publishJob.steps.find(step => step.name === 'Reconcile dist-tag for existing publication');
      const dryRunStep = publishJob.steps.find(step => step.name === 'Dry run for existing publication');

      expect(workflow.concurrency).toEqual({
        group: 'publish-github-packages-protected-channels',
        'cancel-in-progress': false,
      });
      expect(protectedChannelStep?.env?.NODE_AUTH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
      expect(protectedChannelStep?.run).toContain("PUBLISH_TAG='dollhouse-temporary'");
      expect(protectedChannelStep?.run).toContain('node scripts/compare-semver.mjs "$CURRENT" "$TARGET"');
      expect(publishStep?.run).toContain('steps.protected_channel.outputs.publish_tag');
      expect(publishStep?.run).toContain('npm_config_tag="${{ steps.package_dist_tag.outputs.dist_tag }}" npm run prepublishOnly');
      expect(publishStep?.run).toContain('npm publish --ignore-scripts --tag "$PUBLISH_TAG"');
      expect(publishStep?.run).toContain("npm dist-tag rm '@DollhouseMCP/mcp-server'");
      expect(publishStep?.run).toContain('npm run postpublish');
      expect(reconcileStep?.if).toContain("inputs.dry_run != true");
      expect(reconcileStep?.run).toContain('node scripts/compare-semver.mjs "${CURRENT}" "${TARGET}"');
      expect(reconcileStep?.run).toContain('Preserving newer ${DIST_TAG} dist-tag ${CURRENT}');
      expect(reconcileStep?.run).toContain('npm dist-tag add');
      expect(dryRunStep?.if).toContain('inputs.dry_run == true');
      expect(dryRunStep?.run).not.toContain('npm dist-tag add');
    });

    it('should preserve newer protected npm channels with an OIDC-compatible persistent backfill tag', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-npm.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const publishJob = workflow.jobs['publish-npm'];
      const checkVersionStep = publishJob.steps?.find(
        step => step.name === 'Check if npm version already published',
      );
      const protectedChannelStep = publishJob.steps?.find(
        step => step.name === 'Resolve protected npm channel publication mode',
      );
      const publishStep = publishJob.steps?.find(step => step.name === 'Publish to npm (with provenance)');
      const reconcileStep = publishJob.steps?.find(step => step.name === 'Reconcile existing npm publication');

      expect(workflow.concurrency).toEqual({
        group: 'release-publish-${{ github.workflow }}',
        'cancel-in-progress': false,
      });
      expect(checkVersionStep?.run).toContain('NPM_VIEW_STATUS=$?');
      expect(checkVersionStep?.run).toContain('[[ "$PUBLISHED_VERSION" != "$PACKAGE_VERSION" ]]');
      expect(checkVersionStep?.run).toContain('E404');
      expect(protectedChannelStep?.run).toContain("PUBLISH_TAG='dollhouse-backfill'");
      expect(protectedChannelStep?.run).toContain('DIST_TAGS_STATUS=$?');
      expect(protectedChannelStep?.run).toContain('node scripts/compare-semver.mjs "$CURRENT" "$TARGET"');
      expect(protectedChannelStep?.run).toContain('Unable to inspect the protected npm ${DIST_TAG} channel');
      expect(publishStep?.run).toContain('steps.protected_channel.outputs.publish_tag');
      expect(publishStep?.run).toContain('npm_config_tag="${DIST_TAG}" npm run prepublishOnly');
      expect(publishStep?.run).toContain('npm publish --ignore-scripts --provenance --access public --tag "$PUBLISH_TAG"');
      expect(publishStep?.run).toContain('npm run postpublish');
      expect(publishStep?.run).not.toContain('npm dist-tag');
      expect(reconcileStep?.run).toContain('Preserving newer ${DIST_TAG} channel ${CURRENT}');
      expect(reconcileStep?.run).toContain('explicitly authenticated operator workflow');
      expect(reconcileStep?.run).not.toMatch(/^\s*npm dist-tag\b/mu);
    });

    it.each([
      { channel: 'latest', target: '2.0.40', current: '2.0.41' },
      { channel: 'beta', target: '2.1.0-beta.4', current: '2.1.0-beta.5' },
    ])('publishes an older missing $channel version without moving the protected npm channel', ({
      channel,
      target,
      current,
    }) => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-npm.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const script = workflow.jobs['publish-npm'].steps?.find(
        step => step.name === 'Resolve protected npm channel publication mode',
      )?.run;
      expect(script).toBeDefined();

      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-npm-channel-'));
      const binaryDirectory = path.join(temporaryDirectory, 'bin');
      const scriptsDirectory = path.join(temporaryDirectory, 'scripts');
      const npmPath = path.join(binaryDirectory, 'npm');
      const outputPath = path.join(temporaryDirectory, 'github-output');
      fs.mkdirSync(binaryDirectory);
      fs.mkdirSync(scriptsDirectory);
      fs.writeFileSync(path.join(temporaryDirectory, 'package.json'), JSON.stringify({ version: target }), 'utf8');
      fs.copyFileSync(
        path.join(process.cwd(), 'scripts', 'compare-semver.mjs'),
        path.join(scriptsDirectory, 'compare-semver.mjs'),
      );
      fs.writeFileSync(npmPath, [
        '#!/usr/bin/env bash',
        'printf \'%s\' "${FAKE_DIST_TAGS-}"',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(npmPath, 0o755);

      try {
        const result = spawnSync('bash', ['-c', script ?? 'exit 99'], {
          cwd: temporaryDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: temporaryDirectory,
            GITHUB_OUTPUT: outputPath,
            DIST_TAG: channel,
            FAKE_DIST_TAGS: JSON.stringify({ [channel]: current }),
          },
        });
        expect(result.status).toBe(0);
        expect(fs.readFileSync(outputPath, 'utf8')).toContain('publish_tag=dollhouse-backfill');
        expect(fs.readFileSync(outputPath, 'utf8')).toContain('backfill_publish_tag=true');
      } finally {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        fs.unlinkSync(npmPath);
        fs.unlinkSync(path.join(scriptsDirectory, 'compare-semver.mjs'));
        fs.unlinkSync(path.join(temporaryDirectory, 'package.json'));
        fs.rmdirSync(binaryDirectory);
        fs.rmdirSync(scriptsDirectory);
        fs.rmdirSync(temporaryDirectory);
      }
    });

    it('publishes an npm backfill without invoking dist-tag commands unavailable to OIDC', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-npm.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const rawScript = workflow.jobs['publish-npm'].steps?.find(
        step => step.name === 'Publish to npm (with provenance)',
      )?.run;
      expect(rawScript).toBeDefined();
      const script = (rawScript ?? 'exit 99')
        .replaceAll('${{ steps.protected_channel.outputs.publish_tag }}', 'dollhouse-backfill')
        .replaceAll('${{ steps.protected_channel.outputs.backfill_publish_tag }}', 'true');

      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-npm-backfill-'));
      const npmPath = path.join(temporaryDirectory, 'npm');
      const callLog = path.join(temporaryDirectory, 'npm-calls');
      fs.writeFileSync(npmPath, [
        '#!/usr/bin/env bash',
        'printf \'%s|%s\\n\' "${npm_config_tag-}" "$*" >> "$FAKE_NPM_CALL_LOG"',
        'if [[ "${1-}" == "dist-tag" ]]; then exit 91; fi',
        'exit 0',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(npmPath, 0o755);

      try {
        const result = spawnSync('bash', ['-c', script], {
          cwd: temporaryDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
            DIST_TAG: 'beta',
            FAKE_NPM_CALL_LOG: callLog,
          },
        });
        expect(result.status).toBe(0);
        expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toEqual([
          'beta|run prepublishOnly',
          '|publish --ignore-scripts --provenance --access public --tag dollhouse-backfill --loglevel verbose',
          '|run postpublish',
        ]);
      } finally {
        if (fs.existsSync(callLog)) fs.unlinkSync(callLog);
        fs.unlinkSync(npmPath);
        fs.rmdirSync(temporaryDirectory);
      }
    });

    it('reconciles an exact-version npm retry without requiring non-publish OIDC commands', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-npm.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const publishJob = workflow.jobs['publish-npm'];
      const checkScript = publishJob.steps?.find(
        step => step.name === 'Check if npm version already published',
      )?.run;
      const reconcileScript = publishJob.steps?.find(
        step => step.name === 'Reconcile existing npm publication',
      )?.run;
      expect(checkScript).toBeDefined();
      expect(reconcileScript).toBeDefined();

      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-npm-retry-'));
      const binaryDirectory = path.join(temporaryDirectory, 'bin');
      const scriptsDirectory = path.join(temporaryDirectory, 'scripts');
      const npmPath = path.join(binaryDirectory, 'npm');
      const outputPath = path.join(temporaryDirectory, 'github-output');
      const callLog = path.join(temporaryDirectory, 'npm-calls');
      const version = '2.1.0-beta.4';
      fs.mkdirSync(binaryDirectory);
      fs.mkdirSync(scriptsDirectory);
      fs.writeFileSync(path.join(temporaryDirectory, 'package.json'), JSON.stringify({ version }), 'utf8');
      fs.copyFileSync(
        path.join(process.cwd(), 'scripts', 'compare-semver.mjs'),
        path.join(scriptsDirectory, 'compare-semver.mjs'),
      );
      fs.writeFileSync(npmPath, [
        '#!/usr/bin/env bash',
        'printf \'%s\\n\' "$*" >> "$FAKE_NPM_CALL_LOG"',
        'if [[ "$*" == *"@2.1.0-beta.4 version"* ]]; then printf \'2.1.0-beta.4\\n\'; exit 0; fi',
        'if [[ "$*" == *"dist-tags --json"* ]]; then printf \'{"beta":"2.1.0-beta.5"}\\n\'; exit 0; fi',
        'if [[ "${1-}" == "dist-tag" ]]; then exit 91; fi',
        'exit 92',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(npmPath, 0o755);

      try {
        const check = spawnSync('bash', ['-c', checkScript ?? 'exit 99'], {
          cwd: temporaryDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: temporaryDirectory,
            GITHUB_OUTPUT: outputPath,
            PACKAGE_VERSION: version,
            FAKE_NPM_CALL_LOG: callLog,
          },
        });
        expect(check.status).toBe(0);
        expect(fs.readFileSync(outputPath, 'utf8')).toContain('already_published=true');

        const reconcile = spawnSync('bash', ['-c', reconcileScript ?? 'exit 99'], {
          cwd: temporaryDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: temporaryDirectory,
            DIST_TAG: 'beta',
            PACKAGE_VERSION: version,
            FAKE_NPM_CALL_LOG: callLog,
          },
        });
        expect(reconcile.status).toBe(0);
        expect(reconcile.stdout).toContain('Preserving newer beta channel 2.1.0-beta.5');
        expect(fs.readFileSync(callLog, 'utf8')).not.toContain('dist-tag add');
        expect(fs.readFileSync(callLog, 'utf8')).not.toContain('dist-tag rm');
      } finally {
        for (const file of [outputPath, callLog, npmPath, path.join(temporaryDirectory, 'package.json'), path.join(scriptsDirectory, 'compare-semver.mjs')]) {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        fs.rmdirSync(binaryDirectory);
        fs.rmdirSync(scriptsDirectory);
        fs.rmdirSync(temporaryDirectory);
      }
    });

    it('publishes an older missing GitHub Packages version without moving the protected channel', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-github-packages.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const script = workflow.jobs['publish-gpr'].steps?.find(
        step => step.name === 'Resolve protected channel publication mode',
      )?.run;
      expect(script).toBeDefined();

      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-gpr-channel-'));
      const npmPath = path.join(temporaryDirectory, 'npm');
      const outputPath = path.join(temporaryDirectory, 'github-output');
      fs.writeFileSync(npmPath, [
        '#!/usr/bin/env bash',
        'printf \'%s\' "${FAKE_DIST_TAGS-}"',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(npmPath, 0o755);

      try {
        const result = spawnSync('bash', ['-c', script ?? 'exit 99'], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: temporaryDirectory,
            GITHUB_OUTPUT: outputPath,
            DIST_TAG: 'beta',
            FAKE_DIST_TAGS: JSON.stringify({ beta: '999.0.0' }),
          },
        });
        expect(result.status).toBe(0);
        expect(fs.readFileSync(outputPath, 'utf8')).toContain('publish_tag=dollhouse-temporary');
        expect(fs.readFileSync(outputPath, 'utf8')).toContain('temporary_publish_tag=true');
      } finally {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        fs.unlinkSync(npmPath);
        fs.rmdirSync(temporaryDirectory);
      }
    });

    it('prepares a temporary GitHub Packages publication under the protected channel guard', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'publish-github-packages.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const rawScript = workflow.jobs['publish-gpr'].steps?.find(
        step => step.name === 'Publish to GitHub Packages',
      )?.run;
      expect(rawScript).toBeDefined();
      const script = (rawScript ?? 'exit 99')
        .replaceAll('${{ steps.protected_channel.outputs.publish_tag }}', 'dollhouse-temporary')
        .replaceAll('${{ steps.protected_channel.outputs.temporary_publish_tag }}', 'true')
        .replaceAll('${{ steps.package_dist_tag.outputs.dist_tag }}', 'beta');
      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-gpr-publish-'));
      const npmPath = path.join(temporaryDirectory, 'npm');
      const callLog = path.join(temporaryDirectory, 'npm-calls');
      fs.writeFileSync(npmPath, [
        '#!/usr/bin/env bash',
        'printf \'%s|%s\\n\' "${npm_config_tag-}" "$*" >> "$FAKE_NPM_CALL_LOG"',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(npmPath, 0o755);

      try {
        const result = spawnSync('bash', ['-c', script], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
            FAKE_NPM_CALL_LOG: callLog,
          },
        });
        expect(result.status).toBe(0);
        expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toEqual([
          'beta|run prepublishOnly',
          '|publish --ignore-scripts --tag dollhouse-temporary',
          '|dist-tag rm @DollhouseMCP/mcp-server dollhouse-temporary --registry=https://npm.pkg.github.com',
          '|run postpublish',
        ]);
      } finally {
        if (fs.existsSync(callLog)) fs.unlinkSync(callLog);
        fs.unlinkSync(npmPath);
        fs.rmdirSync(temporaryDirectory);
      }
    });

    it('should reuse only a matching published prerelease and safely retry publishers', () => {
      const betaPublishWorkflow = fs.readFileSync(path.join(workflowDir, 'publish-beta-release.yml'), 'utf8');

      expect(betaPublishWorkflow).toContain('refs/tags/${tag_name}^{}');
      expect(betaPublishWorkflow).toContain('[[ "${remote_tag_target}" != "${SOURCE_SHA}" ]]');
      expect(betaPublishWorkflow).toContain('echo "tag_exists=${tag_exists}"');
      expect(betaPublishWorkflow).toContain('--json tagName,isPrerelease,isDraft,targetCommitish');
      expect(betaPublishWorkflow).toContain('[[ "${release_prerelease}" != "true" || "${release_draft}" != "false" ]]');
      expect(betaPublishWorkflow).toContain('[[ "${release_target}" != "${SOURCE_SHA}" ]]');
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

  describe('Privileged workflow supply-chain controls', () => {
    const privilegedWorkflows = [
      'publish-beta-release.yml',
      'publish-npm.yml',
      'publish-github-packages.yml',
      'publish-mcpb.yml',
      'publish-mcp-registry.yml',
      'deploy-beta-alpha-vps.yml',
    ];

    it.each(privilegedWorkflows)('%s pins every external action with a version comment', file => {
      const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
      const actionLines = content
        .split('\n')
        .filter(line => /^\s*-?\s*uses:\s*[^.]/.test(line));

      expect(actionLines.length).toBeGreaterThan(0);
      for (const line of actionLines) {
        expect(line).toMatch(
          /uses:\s*[\w.-]+\/[\w./-]+@[a-f0-9]{40}\s+#\s+v\d+(?:\.\d+){0,2}/,
        );
      }
    });

    it('places every live publisher behind a protected environment and trusted manual refs', () => {
      const publisherJobs: Array<[string, string]> = [
        ['publish-npm.yml', 'publish-npm'],
        ['publish-github-packages.yml', 'publish-gpr'],
        ['publish-mcpb.yml', 'publish-mcpb'],
        ['publish-mcp-registry.yml', 'publish'],
      ];

      for (const [file, jobName] of publisherJobs) {
        const workflow = yaml.load(
          fs.readFileSync(path.join(workflowDir, file), 'utf8'),
        ) as Workflow;
        const job = workflow.jobs[jobName];
        expect(job.environment).toBe('release-publish');
        expect(job.if).toContain("github.event_name != 'workflow_dispatch'");
        expect(job.if).toContain("github.ref == 'refs/heads/main'");
        if (file !== 'publish-mcp-registry.yml') {
          expect(job.if).toContain("startsWith(github.ref, 'refs/tags/v')");
        }
      }

      const deployment = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'deploy-beta-alpha-vps.yml'), 'utf8'),
      ) as Workflow;
      expect(deployment.jobs.deploy.if).toBe("github.ref == 'refs/heads/beta'");
      expect(deployment.jobs.deploy.environment).toEqual(expect.objectContaining({ name: 'alpha' }));
    });

    it('passes untrusted registry dispatch values through environment variables', () => {
      const workflow = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'publish-mcp-registry.yml'), 'utf8'),
      ) as Workflow;
      const resolve = workflow.jobs.publish.steps?.find(
        step => step.name === 'Resolve and validate source ref',
      );
      expect(resolve?.env?.INPUT_RELEASE_REF).toBe('${{ github.event.inputs.release_ref || \'\' }}');
      expect(resolve?.run).toContain('RAW_REF="${INPUT_RELEASE_REF}"');
      expect(resolve?.run).not.toContain('${{ github.event.inputs.release_ref }}');
    });

    it('pins required service and test images to reviewed digests', () => {
      const core = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'core-build-test.yml'), 'utf8'),
      ) as Workflow;
      expect(core.jobs['postgres-integration'].services?.postgres?.image).toBe(
        'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
      );
    });

    it('preserves and enforces Docker smoke command exit statuses', () => {
      const workflow = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'docker-testing.yml'), 'utf8'),
      ) as Workflow;
      const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
      const smokeSteps = [
        '🚀 Test MCP server initialization - ULTRA VERBOSE',
        '🔍 Test MCP server with tools/list command - VERBOSE',
        'Test Docker Compose startup',
      ].map(name => steps.find(step => step.name === name));

      for (const step of smokeSteps) {
        expect(step).toBeDefined();
        expect(step?.run).toContain('set +e');
        expect(step?.run).toContain('set -e');
        expect(step?.run).toMatch(/-ne 0 && .* -ne 124/);
        expect(step?.run).toContain('exit 1');
      }

      const content = fs.readFileSync(path.join(workflowDir, 'docker-testing.yml'), 'utf8');
      expect(content).not.toContain('$DOCKER_CMD 2>&1" || true)');
      expect(content).not.toContain('dollhousemcp:latest-${PLATFORM_TAG} 2>&1" || true)');
      expect(content).not.toContain('dollhousemcp 2>&1\' || true)');
    });

    it('retries npm latest verification and fails closed when it remains unreadable', () => {
      const workflow = yaml.load(
        fs.readFileSync(path.join(workflowDir, 'publish-npm.yml'), 'utf8'),
      ) as Workflow;
      const script = workflow.jobs['publish-npm'].steps?.find(
        step => step.name === 'Verify latest dist-tag integrity',
      )?.run;
      expect(script).toBeDefined();
      expect(script).toContain('NPM_VERIFY_MAX_ATTEMPTS');
      expect(script).toContain('NPM_VERIFY_SLEEP_SECONDS');
      expect(script).toContain('failing closed');

      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-npm-latest-'));
      const npmPath = path.join(temporaryDirectory, 'npm');
      const counterPath = path.join(temporaryDirectory, 'calls');
      fs.writeFileSync(npmPath, [
        '#!/usr/bin/env bash',
        'count=0',
        '[[ -f "$FAKE_COUNTER" ]] && count="$(cat "$FAKE_COUNTER")"',
        'count=$((count + 1))',
        'printf \'%s\' "$count" > "$FAKE_COUNTER"',
        'if [[ "$count" -lt "$FAKE_SUCCEED_ON" ]]; then echo "registry unavailable" >&2; exit 69; fi',
        'printf \'2.0.40\\n\'',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(npmPath, 0o755);

      try {
        const baseEnv = {
          ...process.env,
          PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
          FAKE_COUNTER: counterPath,
          NPM_VERIFY_SLEEP_SECONDS: '0',
        };
        const succeedsAfterRetry = spawnSync('bash', ['-c', script ?? 'exit 99'], {
          encoding: 'utf8',
          env: {
            ...baseEnv,
            FAKE_SUCCEED_ON: '3',
            NPM_VERIFY_MAX_ATTEMPTS: '3',
          },
        });
        expect(succeedsAfterRetry.status).toBe(0);
        expect(fs.readFileSync(counterPath, 'utf8')).toBe('3');

        fs.unlinkSync(counterPath);
        const failsClosed = spawnSync('bash', ['-c', script ?? 'exit 99'], {
          encoding: 'utf8',
          env: {
            ...baseEnv,
            FAKE_SUCCEED_ON: '99',
            NPM_VERIFY_MAX_ATTEMPTS: '2',
          },
        });
        expect(failsClosed.status).toBe(1);
        expect(failsClosed.stdout).toContain('failing closed');
        expect(fs.readFileSync(counterPath, 'utf8')).toBe('2');
      } finally {
        if (fs.existsSync(counterPath)) fs.unlinkSync(counterPath);
        fs.unlinkSync(npmPath);
        fs.rmdirSync(temporaryDirectory);
      }
    });
  });

  describe('Security audit result preservation', () => {
    it('should retain structured findings for artifacts and SARIF before failing the gate', () => {
      const content = fs.readFileSync(path.join(workflowDir, 'security-audit.yml'), 'utf8');
      const workflow = yaml.load(content) as Workflow;
      const scanJob = workflow.jobs['security-audit'];
      const reportJob = workflow.jobs['trusted-report'];
      const checkout = scanJob.steps?.find(step => step.name === 'Checkout code without credentials');

      expect(content).toContain('SecurityAuditFailure');
      expect(content).toContain('result = error.result');
      expect(content).toContain("fs.writeFile('security-audit-result.json', JSON.stringify(result, null, 2))");
      expect(content).toContain('if (auditFailure || result.summary.bySeverity.critical > 0');
      expect(content).toContain('process.exitCode = 1');
      expect(content).toContain('if [[ ! -s security-audit-result.json ]]');
      expect(content).toContain('results: result.findings.map');
      expect(scanJob.permissions).toEqual({ contents: 'read' });
      expect(checkout?.with?.['persist-credentials']).toBe(false);
      expect(reportJob.if).toContain("github.event_name != 'pull_request'");
      expect(reportJob.if).toContain("github.event_name != 'workflow_dispatch'");
      expect(reportJob.if).toContain("github.ref == 'refs/heads/main'");
      expect(reportJob.if).toContain("github.ref == 'refs/heads/develop'");
      expect(reportJob.if).toContain("github.ref == 'refs/heads/beta'");
      expect(reportJob.permissions).toEqual({
        actions: 'read',
        contents: 'read',
        issues: 'write',
        'security-events': 'write',
      });
      expect(reportJob.steps?.some(step => step.uses?.startsWith('actions/checkout@'))).toBe(false);
      expect(reportJob.steps?.some(step => step.run?.includes('npm '))).toBe(false);
      expect(reportJob.steps?.some(step => step.run?.includes('./dist/'))).toBe(false);
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
  return (job.steps ?? []).some(step => {
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
