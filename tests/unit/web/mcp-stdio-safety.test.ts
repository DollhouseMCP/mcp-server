/**
 * MCP stdio safety — web console must not pollute stdout.
 *
 * In MCP stdio mode (Claude Desktop), stdout is reserved for JSON-RPC messages.
 * Any non-JSON output to stdout corrupts the protocol and kills the connection.
 *
 * These tests verify that:
 * 1. The web console banner uses console.error (stderr), not console.log (stdout)
 * 2. No runtime console.log calls exist in server.ts
 * 3. Node.js console stream routing behaves as expected
 *
 * @see Issue #1762 - stdout pollution breaks Claude Desktop MCP connection
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/web/server.ts'
);

/**
 * Parse server.ts and extract executable statements (not comments, not strings).
 * Returns only lines that are actual code — strips single-line comments,
 * skips JSDoc/block comment regions, and ignores blank lines.
 *
 * This is more robust than raw string matching: reformatting, reordering
 * comments, or adding whitespace won't cause false positives.
 */
function getExecutableLines(source: string): string[] {
  const lines = source.split('\n');
  let inBlockComment = false;

  return lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed === '') return false;

    // Track block comments
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return false;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return false;
    }

    // Skip single-line comments
    if (trimmed.startsWith('//')) return false;
    // Skip lines that are purely part of a multi-line JSDoc/comment continuation
    if (trimmed.startsWith('*')) return false;

    return true;
  });
}

describe('MCP stdio safety — web server', () => {
  const serverSource = readFileSync(SERVER_SRC_PATH, 'utf-8');
  const executableLines = getExecutableLines(serverSource);

  describe('banner output stream', () => {
    it('should write the primary banner via console.error, not console.log', () => {
      // Find the executable line that writes the DollhouseMCP banner
      const bannerLines = executableLines.filter(line =>
        line.includes('DollhouseMCP Management Console') && !line.includes('existing instance')
      );

      expect(bannerLines.length).toBeGreaterThanOrEqual(1);
      for (const line of bannerLines) {
        expect(line).toMatch(/console\.error\s*\(/);
        expect(line).not.toMatch(/console\.log\s*\(/);
      }
    });

    it('should write the port-conflict banner via console.error, not console.log', () => {
      const conflictBannerLines = executableLines.filter(line =>
        line.includes('existing instance')
      );

      expect(conflictBannerLines.length).toBeGreaterThanOrEqual(1);
      for (const line of conflictBannerLines) {
        expect(line).toMatch(/console\.error\s*\(/);
        expect(line).not.toMatch(/console\.log\s*\(/);
      }
    });
  });

  describe('no stdout pollution from console.log', () => {
    it('should have zero console.log calls in executable code', () => {
      const consoleLogLines = executableLines.filter(line =>
        /console\.log\s*\(/.test(line)
      );

      // If this fails, someone added a console.log to server.ts.
      // Use console.error (stderr) or logger instead — stdout is for JSON-RPC only.
      expect(consoleLogLines).toEqual([]);
    });

    it('should have zero console.info calls in executable code', () => {
      // console.info also writes to stdout in Node.js
      const consoleInfoLines = executableLines.filter(line =>
        /console\.info\s*\(/.test(line)
      );

      expect(consoleInfoLines).toEqual([]);
    });
  });

  describe('stderr rationale documentation', () => {
    it('should document the MCP stdio constraint near the banner code', () => {
      // The comment block explaining why stderr is required must exist.
      // Check the raw source (including comments) for the key terms.
      // These may span multiple lines, so check each term independently.
      expect(serverSource).toContain('stdout');
      expect(serverSource).toContain('JSON-RPC');
      expect(serverSource).toContain('stderr');
      // Verify the comment specifically mentions MCP protocol safety
      expect(serverSource).toMatch(/MCP.*stdio|stdio.*MCP/i);
    });
  });

  describe('Node.js console stream routing', () => {
    it('console.error routes to stderr, console.log routes to stdout', () => {
      // This test validates the Node.js behavior our fix relies on.
      // If this ever fails, the fix approach needs to be reconsidered.
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
      testConsole.error('goes to stderr');
      testConsole.log('goes to stdout');

      // console.error → stderr (safe for MCP)
      expect(stderrChunks.join('')).toContain('goes to stderr');
      expect(stdoutChunks.join('')).not.toContain('goes to stderr');

      // console.log → stdout (would corrupt MCP JSON-RPC)
      expect(stdoutChunks.join('')).toContain('goes to stdout');
      expect(stderrChunks.join('')).not.toContain('goes to stdout');
    });
  });
});
