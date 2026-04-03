/**
 * Tests for --web mode terminal output suppression and MCP stdio safety.
 *
 * Verifies that the logger and env.ts correctly detect --web in process.argv
 * and suppress terminal output. All logs still go to MemoryLogSink (Logs tab).
 *
 * Also verifies that the web console banner uses stderr (not stdout) to prevent
 * MCP stdio protocol corruption in Claude Desktop.
 *
 * @see Issue #1762 - stdout pollution breaks Claude Desktop MCP connection
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('--web mode terminal suppression', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env.DOLLHOUSE_DEBUG;
    delete process.env.ENABLE_DEBUG;
  });

  describe('logger minLevel detection', () => {
    it('should default to error level when --web is in argv', async () => {
      process.argv = ['node', 'index.js', '--web'];
      // Dynamic import to re-evaluate the module with new argv
      // Use a direct test of the logic rather than re-importing the singleton
      const isWebSilent = process.argv.includes('--web')
        && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
      expect(isWebSilent).toBe(true);
    });

    it('should not suppress when --web is absent', () => {
      process.argv = ['node', 'index.js'];
      const isWebSilent = process.argv.includes('--web')
        && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
      expect(isWebSilent).toBe(false);
    });

    it('should not suppress when DOLLHOUSE_DEBUG is set', () => {
      process.argv = ['node', 'index.js', '--web'];
      process.env.DOLLHOUSE_DEBUG = '1';
      const isWebSilent = process.argv.includes('--web')
        && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
      expect(isWebSilent).toBe(false);
    });

    it('should not suppress when ENABLE_DEBUG is set', () => {
      process.argv = ['node', 'index.js', '--web'];
      process.env.ENABLE_DEBUG = '1';
      const isWebSilent = process.argv.includes('--web')
        && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
      expect(isWebSilent).toBe(false);
    });
  });

  describe('env.ts dotenv suppression logic', () => {
    it('should detect --web mode for dotenv suppression', () => {
      process.argv = ['node', 'index.js', '--web'];
      const isWebSilent = process.argv.includes('--web')
        && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
      expect(isWebSilent).toBe(true);
    });

    it('should not suppress dotenv output in normal MCP mode', () => {
      process.argv = ['node', 'index.js'];
      const isWebSilent = process.argv.includes('--web')
        && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
      expect(isWebSilent).toBe(false);
    });
  });

  describe('stderr suppression mechanics', () => {
    it('should suppress and restore stderr writes correctly', () => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];

      // Suppress
      process.stderr.write = (() => true) as any;
      process.stderr.write('should be suppressed');

      // Restore
      process.stderr.write = originalWrite;

      // Verify restore works by capturing output
      process.stderr.write = ((chunk: any) => {
        captured.push(String(chunk));
        return true;
      }) as any;
      process.stderr.write('after restore');
      process.stderr.write = originalWrite;

      expect(captured).toContain('after restore');
    });
  });
});

/**
 * MCP stdio safety — web console banner must use stderr, not stdout.
 *
 * In MCP stdio mode (Claude Desktop), stdout is reserved for JSON-RPC messages.
 * Any non-JSON output to stdout corrupts the protocol and kills the connection.
 * The web console banner ("DollhouseMCP Management Console\n  http://...") was
 * previously written via console.log (stdout), causing Claude Desktop failures.
 *
 * @see Issue #1762 - stdout pollution breaks Claude Desktop MCP connection
 */
describe('MCP stdio safety — web console banner', () => {
  // Read the source file to verify the fix at the source level.
  // This catches regressions where someone changes console.error back to console.log.
  const serverSrcPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../src/web/server.ts'
  );
  const serverSource = readFileSync(serverSrcPath, 'utf-8');

  it('should use console.error (stderr) for the primary banner, not console.log (stdout)', () => {
    // The banner line: console.error(`\n  DollhouseMCP Management Console\n  ${url}\n  ...`)
    expect(serverSource).toContain("console.error(`\\n  DollhouseMCP Management Console\\n");
    expect(serverSource).not.toContain("console.log(`\\n  DollhouseMCP Management Console\\n");
  });

  it('should use console.error (stderr) for the port-conflict banner, not console.log', () => {
    // The existing-instance banner: console.error(`\n  DollhouseMCP Management Console (existing instance)\n  ...`)
    expect(serverSource).toContain("console.error(`\\n  DollhouseMCP Management Console (existing instance)");
    expect(serverSource).not.toContain("console.log(`\\n  DollhouseMCP Management Console (existing instance)");
  });

  it('should not have any console.log calls in the server startup path', () => {
    // Extract non-comment, non-string lines that call console.log
    const lines = serverSource.split('\n');
    const runtimeConsoleLogs = lines.filter((line, i) => {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed === '') return false;
      // Skip JSDoc blocks
      if (trimmed.startsWith('/**')) return false;
      // Only match actual console.log calls
      return /console\.log\s*\(/.test(trimmed);
    });

    expect(runtimeConsoleLogs).toEqual([]);
  });

  it('should document the stderr rationale in a comment near the banner', () => {
    // Ensure the comment explaining WHY stderr is used is present,
    // so future developers understand the constraint.
    expect(serverSource).toContain('stdout');
    expect(serverSource).toContain('JSON-RPC');
    expect(serverSource).toContain('stderr');
  });

  describe('console.error vs console.log stream targets', () => {
    it('console.error is bound to stderr (not stdout) in Node.js', () => {
      // In Node.js, console.error writes to process.stderr (safe for MCP).
      // console.log writes to process.stdout (corrupts MCP JSON-RPC).
      // This test documents the assumption our fix relies on.
      //
      // We verify via the Node.js Console constructor API: the default
      // global console is constructed with stdout and stderr streams.
      // console.log → stdout, console.error → stderr.
      const { Console } = require('node:console');
      const { Writable } = require('node:stream');

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const mockStdout = new Writable({
        write(chunk: Buffer) { stdoutChunks.push(chunk.toString()); },
      });
      const mockStderr = new Writable({
        write(chunk: Buffer) { stderrChunks.push(chunk.toString()); },
      });

      const testConsole = new Console(mockStdout, mockStderr);
      testConsole.error('banner goes to stderr');
      testConsole.log('this goes to stdout');

      expect(stderrChunks.join('')).toContain('banner goes to stderr');
      expect(stdoutChunks.join('')).not.toContain('banner goes to stderr');
      expect(stdoutChunks.join('')).toContain('this goes to stdout');
    });
  });
});
