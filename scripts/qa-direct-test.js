#!/usr/bin/env node

/**
 * Direct MCP SDK QA runner.
 *
 * Starts the compiled server once per supported interface configuration,
 * verifies the complete advertised surface, and makes representative
 * read-only calls through the MCP protocol.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  QA_MODE_CONTRACTS,
  createIsolatedQaEnvironment,
  timestampForFilename,
  validateToolCallResult,
  validateToolSurface,
  withTimeout,
} from './qa-mcp-mode-contract.js';

const SERVER_START_TIMEOUT_MS = 45_000;
const TOOL_CALL_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
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

function summarizeCallResult(result) {
  return {
    isError: result?.isError === true,
    contentTypes: Array.isArray(result?.content)
      ? result.content.map((entry) => entry?.type ?? 'unknown')
      : [],
  };
}

async function closeConnection(client, transport) {
  try {
    await withTimeout(client.close(), SHUTDOWN_TIMEOUT_MS, 'MCP client shutdown');
    return;
  } catch {
    // Fall through to the transport-level close if the protocol close failed.
  }

  try {
    await withTimeout(transport.close(), SHUTDOWN_TIMEOUT_MS, 'MCP transport shutdown');
  } catch {
    // The child is already gone or unresponsive; the mode result records the
    // primary failure and the isolated process has no reusable state.
  }
}

async function runCall(client, call) {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(
      client.callTool({ name: call.tool, arguments: call.arguments }),
      TOOL_CALL_TIMEOUT_MS,
      `${call.tool} call`,
    );
    const validation = validateToolCallResult(result);
    return {
      test: `tools/call: ${call.label}`,
      tool: call.tool,
      success: validation.success,
      error: validation.error,
      duration_ms: elapsed(startedAt),
      result: summarizeCallResult(result),
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
  const isolated = await createIsolatedQaEnvironment(contract, 'direct');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: process.cwd(),
    env: isolated.environment,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: `dollhouse-qa-direct-${contract.id}`, version: '1.0.0' },
    { capabilities: {} },
  );
  const tests = [];
  let serverStderr = '';

  console.log(`\n[direct] ${contract.label}`);

  try {
    const connection = client.connect(transport);
    transport.stderr?.on('data', (data) => {
      serverStderr += data.toString();
    });
    await withTimeout(connection, SERVER_START_TIMEOUT_MS, `${contract.id} server connection`);

    const listStartedAt = Date.now();
    const listed = await withTimeout(
      client.listTools(),
      TOOL_CALL_TIMEOUT_MS,
      `${contract.id} tools/list`,
    );
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

    for (const call of contract.calls) {
      const result = await runCall(client, call);
      tests.push(result);
      console.log(`  ${result.success ? 'PASS' : 'FAIL'} ${call.label}`);
    }
  } catch (error) {
    tests.push({
      test: 'connect and initialize MCP session',
      success: false,
      error: failureMessage(error),
      duration_ms: elapsed(startedAt),
    });
    console.log(`  FAIL connection: ${failureMessage(error)}`);
  } finally {
    await closeConnection(client, transport);
    await isolated.dispose();
  }

  const success = tests.length > 0 && tests.every((test) => test.success);
  return {
    id: contract.id,
    label: contract.label,
    interface_environment: contract.environment,
    success,
    duration_ms: elapsed(startedAt),
    tests,
    ...(success || serverStderr.length === 0 ? {} : { server_stderr: tail(serverStderr) }),
  };
}

async function writeReport(modeResults, startedAt) {
  const endedAt = new Date();
  const tests = modeResults.flatMap((mode) => mode.tests);
  const successful = tests.filter((test) => test.success).length;
  const failed = tests.length - successful;
  const successRate = tests.length === 0 ? 0 : Math.round((successful / tests.length) * 100);
  const report = {
    test_type: 'Direct MCP SDK mode-matrix validation',
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
    `qa-direct-test-results-${timestampForFilename(endedAt)}.json`,
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return { report, reportPath };
}

export async function runDirectQa() {
  const startedAt = new Date();
  const modeResults = [];

  console.log('Starting direct MCP SDK mode-matrix QA');
  for (const contract of QA_MODE_CONTRACTS) {
    modeResults.push(await runMode(contract));
  }

  const { report, reportPath } = await writeReport(modeResults, startedAt);
  console.log(`\nDirect QA: ${report.summary.successful_tests}/${report.summary.total_tests} checks passed`);
  console.log(`Report: ${reportPath}`);
  return report;
}

function isDirectExecution() {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === path.resolve(invokedPath);
}

if (isDirectExecution()) {
  try {
    const report = await runDirectQa();
    process.exitCode = report.summary.failed_tests === 0 ? 0 : 1;
  } catch (error) {
    console.error(`Direct QA failed: ${failureMessage(error)}`);
    process.exitCode = 1;
  }
}
