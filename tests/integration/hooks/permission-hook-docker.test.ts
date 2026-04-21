import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Keep Dockerized wrapper assertions in sync with
// docs/architecture/permission-hook-platform-contracts.md.

jest.setTimeout(180_000);

const SAFE_HOST_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const DOCKER_BIN = resolveDockerBinary();

const DOCKER_AVAILABLE = (() => {
  if (process.env.DOCKER_AVAILABLE === 'false') {
    return false;
  }
  try {
    execFileSync(DOCKER_BIN, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const suite = DOCKER_AVAILABLE ? describe : describe.skip;
const IMAGE_TAG = `dollhouse-hook-harness:${randomUUID().slice(0, 8)}`;
const DOCKERFILE_PATH = 'tests/docker/permission-hooks/Dockerfile';

interface HookCase {
  hookScript: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
  hookEnv?: Record<string, string>;
  portDiscoveryMode?: 'shared' | 'pid' | 'both';
}

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  requestBody: Record<string, unknown>;
}

suite('Dockerized permission hook adapters', () => {
  beforeAll(() => {
    execFileSync(
      DOCKER_BIN,
      ['build', '-t', IMAGE_TAG, '-f', DOCKERFILE_PATH, '.'],
      { cwd: process.cwd(), stdio: 'inherit' },
    );
  });

  afterAll(() => {
    try {
      execFileSync(DOCKER_BIN, ['image', 'rm', '-f', IMAGE_TAG], { stdio: 'ignore' });
    } catch (error) {
      process.stderr.write(
        `[permission-hook-docker] Failed to remove Docker image ${IMAGE_TAG}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });

  it('runs the Claude Code shared hook inside Docker and preserves the request contract', () => {
    const result = runHookCase({
      hookScript: '/workspace/scripts/pretooluse-dollhouse.sh',
      hookEnv: { DOLLHOUSE_HOOK_PLATFORM: 'claude_code' },
      payload: {
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      },
      response: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(parseHookStdout(result, '/workspace/scripts/pretooluse-dollhouse.sh')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    expect(result.requestBody).toEqual({
      tool_name: 'Read',
      input: { file_path: 'README.md' },
      platform: 'claude_code',
      session_id: 'docker-hook-session',
    });
  });

  it('runs the Codex hook inside Docker and forwards Codex-style Bash payloads', () => {
    const result = runHookCase({
      hookScript: '/workspace/scripts/pretooluse-codex.sh',
      payload: {
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
      },
      response: {
        hookSpecificOutput: {
          permissionDecision: 'allow',
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(parseHookStdout(result, '/workspace/scripts/pretooluse-codex.sh')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: '',
      },
    });
    expect(result.requestBody).toEqual({
      tool_name: 'Bash',
      input: { command: 'pwd' },
      platform: 'codex',
      session_id: 'docker-hook-session',
    });
  });

  it('runs the Cursor hook inside Docker and preserves Cursor permission responses', () => {
    const result = runHookCase({
      hookScript: '/workspace/scripts/pretooluse-cursor.sh',
      payload: {
        toolName: 'Bash',
        toolInput: { command: 'git status' },
      },
      response: {
        permission: 'deny',
        reason: 'Blocked by policy',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(parseHookStdout(result, '/workspace/scripts/pretooluse-cursor.sh')).toEqual({
      permission: 'deny',
      reason: 'Blocked by policy',
    });
    expect(result.requestBody).toEqual({
      tool_name: 'Bash',
      input: { command: 'git status' },
      platform: 'cursor',
      session_id: 'docker-hook-session',
    });
  });

  it('runs the Gemini hook inside Docker and preserves Gemini decision payloads', () => {
    const result = runHookCase({
      hookScript: '/workspace/scripts/pretooluse-gemini.sh',
      payload: {
        toolName: 'Write',
        toolInput: { file_path: 'notes.txt' },
      },
      response: {
        decision: 'deny',
        reason: 'Blocked by policy',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(parseHookStdout(result, '/workspace/scripts/pretooluse-gemini.sh')).toEqual({
      decision: 'deny',
      reason: 'Blocked by policy',
    });
    expect(result.requestBody).toEqual({
      tool_name: 'Write',
      input: { file_path: 'notes.txt' },
      platform: 'gemini',
      session_id: 'docker-hook-session',
    });
  });

  it('runs the VS Code hook inside Docker and normalizes runTerminalCommand into Bash', () => {
    const result = runHookCase({
      hookScript: '/workspace/scripts/pretooluse-vscode.sh',
      payload: {
        toolName: 'runTerminalCommand',
        toolInput: { command: 'npm install' },
        cwd: '/workspace',
      },
      response: {
        allowed: false,
        reason: 'Blocked by policy',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(parseHookStdout(result, '/workspace/scripts/pretooluse-vscode.sh')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked by policy',
      },
    });
    expect(result.requestBody).toEqual({
      tool_name: 'Bash',
      input: {
        command: 'npm install',
        cwd: '/workspace',
      },
      platform: 'vscode',
      session_id: 'docker-hook-session',
    });
  });

  it('runs the Windsurf hook inside Docker and maps deny responses to exit code 2', () => {
    const result = runHookCase({
      hookScript: '/workspace/scripts/pretooluse-windsurf.sh',
      payload: {
        hook_event_name: 'pre_run_command',
        tool_info: {
          command_line: 'rm -rf /tmp/demo',
          cwd: '/workspace',
        },
      },
      response: {
        allowed: false,
        reason: 'Blocked by policy',
      },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).toContain('Blocked by policy');
    expect(result.requestBody).toEqual({
      tool_name: 'Bash',
      input: {
        command: 'rm -rf /tmp/demo',
        cwd: '/workspace',
      },
      platform: 'windsurf',
      session_id: 'docker-hook-session',
    });
  });

  it('surfaces a clear error when a hook exits without emitting JSON', () => {
    const hookScript = '/workspace/tests/docker/permission-hooks/fixtures/no-output.sh';
    expect(() => parseHookStdout(runHookCase({
      hookScript,
      payload: {},
      response: { ignored: true },
    }), hookScript)).toThrow(
      'Hook /workspace/tests/docker/permission-hooks/fixtures/no-output.sh produced no JSON output (exit 1)',
    );
  });

  it('surfaces malformed hook output with stdout and stderr context', () => {
    const hookScript = '/workspace/tests/docker/permission-hooks/fixtures/invalid-json-output.sh';
    expect(() => parseHookStdout(runHookCase({
      hookScript,
      payload: {},
      response: { ignored: true },
    }), hookScript)).toThrow(
      'Hook /workspace/tests/docker/permission-hooks/fixtures/invalid-json-output.sh returned malformed JSON',
    );
  });
});

function runHookCase(testCase: HookCase): HookResult {
  const args = [
    'run',
    '--rm',
    '-e', `HOOK_SCRIPT=${testCase.hookScript}`,
    '-e', `HOOK_PAYLOAD_B64=${Buffer.from(JSON.stringify(testCase.payload)).toString('base64')}`,
    '-e', `MOCK_RESPONSE_B64=${Buffer.from(JSON.stringify(testCase.response)).toString('base64')}`,
    '-e', `PORT_DISCOVERY_MODE=${testCase.portDiscoveryMode ?? 'shared'}`,
  ];

  if (testCase.hookEnv && Object.keys(testCase.hookEnv).length > 0) {
    args.push(
      '-e',
      `HOOK_ENV_B64=${Buffer.from(JSON.stringify(testCase.hookEnv)).toString('base64')}`,
    );
  }

  args.push(IMAGE_TAG);

  const result = spawnSync(DOCKER_BIN, args, {
    cwd: resolve(process.cwd()),
    encoding: 'utf-8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === null) {
    throw new Error(`Docker run terminated unexpectedly for ${testCase.hookScript}`);
  }

  if (!result.stdout.trim()) {
    throw new Error(
      `Docker run produced no JSON output for ${testCase.hookScript} (exit ${result.status})\n` +
      `stderr:\n${result.stderr}`,
    );
  }

  try {
    return JSON.parse(result.stdout.trim()) as HookResult;
  } catch (error) {
    throw new Error(
      `Docker run returned malformed JSON for ${testCase.hookScript} (exit ${result.status}): ${error instanceof Error ? error.message : String(error)}\n` +
      `stdout:\n${result.stdout}\n` +
      `stderr:\n${result.stderr}`,
    );
  }
}

function parseHookStdout(result: HookResult, hookScript: string): unknown {
  if (!result.stdout.trim()) {
    throw new Error(
      `Hook ${hookScript} produced no JSON output (exit ${result.exitCode})\n` +
      `stderr:\n${result.stderr}`,
    );
  }

  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `Hook ${hookScript} returned malformed JSON (exit ${result.exitCode}): ${error instanceof Error ? error.message : String(error)}\n` +
      `stdout:\n${result.stdout}\n` +
      `stderr:\n${result.stderr}`,
    );
  }
}

function resolveDockerBinary(): string {
  return execFileSync(
    '/usr/bin/env',
    ['-i', `PATH=${SAFE_HOST_PATH}`, 'sh', '-lc', 'command -v docker'],
    { encoding: 'utf-8' },
  ).trim();
}
