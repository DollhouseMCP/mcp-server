#!/usr/bin/env node

/**
 * MCP Inspector CLI black-box QA runner.
 *
 * Each command is executed through the installed Inspector CLI package, so
 * this validates the compiled server from an external MCP client's point of
 * view. No package download or live network access is required.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QA_MODE_CONTRACTS,
  createIsolatedQaEnvironment,
  timestampForFilename,
  validateToolCallResult,
  validateToolSurface,
} from './qa-mcp-mode-contract.js';

const require = createRequire(import.meta.url);
const INSPECTOR_CLI_PATH = require.resolve('@modelcontextprotocol/inspector-cli/build/index.js');
const INSPECTOR_WORKING_DIRECTORY = path.dirname(INSPECTOR_CLI_PATH);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_BOOTSTRAP_PATH = path.join(PROJECT_ROOT, 'scripts', 'qa-server-bootstrap.js');
const COMMAND_TIMEOUT_MS = 45_000;
const REPORT_DIRECTORY = path.join('docs', 'QA');

function elapsed(startedAt) {
  return Date.now() - startedAt;
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function tail(value, maximumLength = 4_000) {
  return value.length <= maximumLength ? value : value.slice(-maximumLength);
}

function inspectorToolArguments(toolArguments) {
  return Object.entries(toolArguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
}

function inspectorArguments(method, options) {
  const args = [
    INSPECTOR_CLI_PATH,
    process.execPath,
    SERVER_BOOTSTRAP_PATH,
    '--method',
    method,
  ];

  if (options.toolName) {
    args.push('--tool-name', options.toolName);
  }
  const toolArguments = inspectorToolArguments(options.toolArguments ?? {});
  if (toolArguments.length > 0) {
    args.push('--tool-arg', ...toolArguments);
  }
  return args;
}

function runInspectorCommand(method, options, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, inspectorArguments(method, options), {
      // inspector-cli 0.21.1 resolves ../package.json against process.cwd().
      // Its installed build directory is therefore the only reliable launch
      // directory. The server bootstrap restores the repository cwd.
      cwd: INSPECTOR_WORKING_DIRECTORY,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeoutId);
      if (timedOut) {
        reject(new Error(`Inspector ${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        const detail = tail(
          [stderr.trim(), stdout.trim()].filter(Boolean).join('\n') ||
            `signal ${signal ?? 'unknown'}`,
        );
        reject(new Error(`Inspector ${method} exited with code ${code}: ${detail}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Inspector ${method} returned invalid JSON: ${failureMessage(error)}`));
      }
    });
  });
}

async function runInspectorCall(call, environment) {
  const startedAt = Date.now();
  try {
    const result = await runInspectorCommand('tools/call', {
      toolName: call.tool,
      toolArguments: call.arguments,
    }, environment);
    const validation = validateToolCallResult(result);
    return {
      test: `tools/call: ${call.label}`,
      tool: call.tool,
      success: validation.success,
      error: validation.error,
      duration_ms: elapsed(startedAt),
    };
  } catch (error) {
    return {
      test: `tools/call: ${call.label}`,
      tool: call.tool,
      success: false,
      error: failureMessage(error),
      duration_ms: elapsed(startedAt),
    };
  }
}

async function runMode(contract) {
  const startedAt = Date.now();
  const isolated = await createIsolatedQaEnvironment(contract, 'inspector');
  const tests = [];

  console.log(`\n[inspector] ${contract.label}`);
  try {
    const listStartedAt = Date.now();
    try {
      const listed = await runInspectorCommand('tools/list', {}, isolated.environment);
      const surface = validateToolSurface(contract, listed.tools);
      tests.push({
        test: 'tools/list mode contract',
        success: surface.success,
        error: surface.errors.join('; ') || null,
        duration_ms: elapsed(listStartedAt),
        advertised_tool_count: surface.names.length,
        advertised_tools: surface.names,
      });
      console.log(`  ${surface.success ? 'PASS' : 'FAIL'} tools/list (${surface.names.length} tools)`);
    } catch (error) {
      tests.push({
        test: 'tools/list mode contract',
        success: false,
        error: failureMessage(error),
        duration_ms: elapsed(listStartedAt),
      });
      console.log(`  FAIL tools/list: ${failureMessage(error)}`);
    }

    for (const call of contract.calls) {
      const result = await runInspectorCall(call, isolated.environment);
      tests.push(result);
      console.log(`  ${result.success ? 'PASS' : 'FAIL'} ${call.label}`);
    }
  } finally {
    await isolated.dispose();
  }

  return {
    id: contract.id,
    label: contract.label,
    interface_environment: contract.environment,
    success: tests.length > 0 && tests.every((test) => test.success),
    duration_ms: elapsed(startedAt),
    tests,
  };
}

async function writeReport(modeResults, startedAt) {
  const endedAt = new Date();
  const tests = modeResults.flatMap((mode) => mode.tests);
  const successful = tests.filter((test) => test.success).length;
  const failed = tests.length - successful;
  const successRate = tests.length === 0 ? 0 : Math.round((successful / tests.length) * 100);
  const report = {
    test_type: 'MCP Inspector CLI external mode-matrix validation',
    timestamp: endedAt.toISOString(),
    duration: `${endedAt.getTime() - startedAt.getTime()}ms`,
    summary: {
      modes_tested: modeResults.length,
      successful_modes: modeResults.filter((mode) => mode.success).length,
      total_tests: tests.length,
      successful_tests: successful,
      failed_tests: failed,
      success_rate: `${successRate}%`,
    },
    modes: modeResults,
  };

  await mkdir(REPORT_DIRECTORY, { recursive: true });
  const reportPath = path.join(
    REPORT_DIRECTORY,
    `qa-inspector-test-results-${timestampForFilename(endedAt)}.json`,
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return { report, reportPath };
}

export async function runInspectorQa() {
  const startedAt = new Date();
  const modeResults = [];

  console.log('Starting MCP Inspector CLI mode-matrix QA');
  for (const contract of QA_MODE_CONTRACTS) {
    modeResults.push(await runMode(contract));
  }

  const { report, reportPath } = await writeReport(modeResults, startedAt);
  console.log(`\nInspector QA: ${report.summary.successful_tests}/${report.summary.total_tests} checks passed`);
  console.log(`Report: ${reportPath}`);
  return report;
}

function isDirectExecution() {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === path.resolve(invokedPath);
}

if (isDirectExecution()) {
  try {
    const report = await runInspectorQa();
    process.exitCode = report.summary.failed_tests === 0 ? 0 : 1;
  } catch (error) {
    console.error(`Inspector QA failed: ${failureMessage(error)}`);
    process.exitCode = 1;
  }
}
