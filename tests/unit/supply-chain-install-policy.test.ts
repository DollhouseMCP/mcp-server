import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();

const workflowFiles = [
  'build-artifacts.yml',
  'codeql.yml',
  'core-build-test.yml',
  'cross-platform-simple.yml',
  'deploy-beta-alpha-vps.yml',
  'extended-node-compatibility.yml',
  'performance-testing.yml',
  'publish-github-packages.yml',
  'publish-mcp-registry.yml',
  'publish-mcpb.yml',
  'publish-npm.yml',
  'qa-tests.yml',
  'security-audit.yml',
  'version-update.yml'
].map(file => path.join('.github', 'workflows', file));

const dockerfiles = [
  'docker/Dockerfile',
  'docker/Dockerfile.ci-simulation',
  'docker/Dockerfile.prebuilt',
  'docker/Dockerfile.test-enhanced',
  'docker/test-configs/Dockerfile.claude-testing',
  'docker/test-configs/Dockerfile.claude-testing.optimized'
];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function executableLines(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

describe('supply-chain install policy', () => {
  it.each(workflowFiles)('%s disables lifecycle scripts for npm installs', file => {
    const installLines = executableLines(read(file)).filter(line => /npm (ci|install)\b/.test(line));

    expect(installLines.length).toBeGreaterThan(0);
    for (const line of installLines) {
      expect(line).toContain('--ignore-scripts');
    }
  });

  it('uses locked local tools and HTTPS-only redirects in workflows', () => {
    const buildWorkflow = read('.github/workflows/build-artifacts.yml');
    const coreWorkflow = read('.github/workflows/core-build-test.yml');
    const qaWorkflow = read('.github/workflows/qa-tests.yml');
    const qaInspectorRunner = read('scripts/qa-inspector-cli-test.js');
    const packageManifest = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
    };
    const registryWorkflow = read('.github/workflows/publish-mcp-registry.yml');
    const bundleWorkflow = read('.github/workflows/publish-mcpb.yml');

    expect(buildWorkflow).toContain('apt-get install -y --no-install-recommends shellcheck');
    expect(executableLines(coreWorkflow).some(line => /\bnpx\b/.test(line))).toBe(false);
    expect(executableLines(qaWorkflow).some(line => /\bnpx\b/.test(line))).toBe(false);
    expect(qaWorkflow).toContain('npm run qa:inspector');
    expect(packageManifest.scripts?.['qa:inspector'])
      .toBe('node scripts/qa-inspector-cli-test.js');
    expect(qaInspectorRunner)
      .toContain("require.resolve('@modelcontextprotocol/inspector-cli/build/index.js')");
    expect(registryWorkflow.match(/--proto '=https' --proto-redir '=https'/g)).toHaveLength(2);
    expect(bundleWorkflow).toContain('@anthropic-ai/mcpb@2.1.2');
  });

  it.each(dockerfiles)('%s disables lifecycle scripts for npm installs', file => {
    const installLines = executableLines(read(file)).filter(
      line => /npm (ci|install)\b/.test(line)
    );

    expect(installLines.length).toBeGreaterThan(0);
    for (const line of installLines) {
      expect(line).toContain('--ignore-scripts');
    }
  });

  it.each(dockerfiles)('%s avoids implicit package recommendations and on-demand tools', file => {
    const content = read(file);
    const aptInstallLines = executableLines(content).filter(line => line.includes('apt-get install'));

    for (const line of aptInstallLines) {
      expect(line).toContain('--no-install-recommends');
    }
    expect(content).not.toContain('@latest');
    expect(content).not.toContain('CMD ["npx"');
  });

  it.each([
    'docker/test-configs/Dockerfile.claude-testing',
    'docker/test-configs/Dockerfile.claude-testing.optimized'
  ])('%s pins the Claude Code test dependency', file => {
    const content = read(file);

    expect(content).toMatch(/FROM node:22/);
    expect(content).toContain(
      'npm install -g --ignore-scripts @anthropic-ai/claude-code@2.1.222'
    );
    expect(content).toContain(
      'node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs"'
    );
    expect(content).toMatch(/^RUN claude --version$/m);
    expect(content).not.toMatch(/^RUN claude --version.*\|\|/m);
    expect(content).not.toContain('claude --version 2>/dev/null ||');
    expect(content).not.toMatch(/^COPY.*(?:\|\||2>)/m);
  });

  it('uses the installed Claude Code command as the default test-image command', () => {
    const content = read('docker/test-configs/Dockerfile.claude-testing');

    expect(content).toContain('CMD ["claude"]');
    expect(content).not.toContain('CMD ["claude-code"]');
  });

  it('copies the built safety package into the optimized Claude runtime image', () => {
    expect(read('docker/test-configs/Dockerfile.claude-testing.optimized')).toContain(
      'COPY --from=builder /build/packages ./packages'
    );
  });

  it('pins binary-only YAML validation dependencies', () => {
    const action = read('.github/actions/validate-yaml/action.yml');

    expect(action).toContain('--only-binary=:all: --no-deps');
    expect(action).toContain('yamllint==1.37.1');
    expect(action).toContain('pathspec==0.12.1');
    expect(action).toContain('PyYAML==6.0.3');
  });

  it('keeps setup and bundle scripts deterministic', () => {
    const setup = read('scripts/setup.sh');
    const npmSetup = read('scripts/setup-npm.sh');
    const bundle = read('scripts/build-mcpb.sh');
    const calibration = read('scripts/run-calibration.sh');

    expect(setup).toContain('npm ci --ignore-scripts');
    expect(npmSetup).toContain('@dollhousemcp/mcp-server@${PACKAGE_VERSION}');
    expect(npmSetup).toContain('npm install -g --ignore-scripts');
    expect(npmSetup).toContain('"command": "dollhousemcp"');
    expect(npmSetup).not.toMatch(/\bnpx\b/);
    expect(bundle).not.toMatch(/\bnpx\b/);
    expect(bundle).toContain('npm ci --omit=dev --ignore-scripts');
    expect(bundle).not.toContain('npm install --omit=dev');
    expect(calibration).not.toMatch(/\bnpx\b/);
  });

  it('uses lockfile-installed tools in package scripts', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;

    expect(Object.values(scripts).some(script => /\bnpx\b/.test(script))).toBe(false);
    expect(scripts.setup).toContain('npm ci --ignore-scripts');
  });

  it('uses HTTPS in the permission-policy test payload', () => {
    const behaviorTests = read('tests/scripts/docker/mcp-aql-behavior-tests.sh');

    expect(behaviorTests).toContain('curl https://example.com');
    expect(behaviorTests).not.toContain('curl http://example.com');
  });
});
