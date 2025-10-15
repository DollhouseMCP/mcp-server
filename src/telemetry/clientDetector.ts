/**
 * MCP Client Detector for Telemetry
 *
 * Detects which MCP client is running the server by examining environment variables,
 * process arguments, and parent process information. Used for telemetry and debugging.
 *
 * Issue #1358: MCP client detection for enhanced telemetry
 */

export type MCPClientType = 'claude-desktop' | 'claude-code' | 'vscode' | 'unknown';

/**
 * Detect client from environment variables (most reliable)
 * @internal
 */
function detectFromEnvironmentVariables(): MCPClientType | null {
  // Claude Desktop detection
  if (process.env.CLAUDE_DESKTOP === 'true' || process.env.CLAUDE_DESKTOP_VERSION) {
    return 'claude-desktop';
  }

  // Claude Code detection
  if (process.env.CLAUDE_CODE === 'true' || process.env.TERM_PROGRAM === 'claude-code') {
    return 'claude-code';
  }

  // VS Code detection
  if (process.env.VSCODE_CWD || process.env.VSCODE_PID ||
      process.env.VSCODE_IPC_HOOK || process.env.VSCODE_NLS_CONFIG ||
      process.env.TERM_PROGRAM === 'vscode') {
    return 'vscode';
  }

  return null;
}

/**
 * Detect client from process arguments
 * @internal
 */
function detectFromProcessArguments(): MCPClientType | null {
  const argv = process.argv.join(' ').toLowerCase();

  if (argv.includes('claude') && argv.includes('desktop')) {
    return 'claude-desktop';
  }

  if (argv.includes('claude') && argv.includes('code')) {
    return 'claude-code';
  }

  if (argv.includes('vscode') || argv.includes('code.exe')) {
    return 'vscode';
  }

  return null;
}

/**
 * Detect client from process metadata (execPath and title)
 * @internal
 */
function detectFromProcessMetadata(): MCPClientType | null {
  const execPath = process.execPath?.toLowerCase() ?? '';
  const processTitle = process.title?.toLowerCase() ?? '';

  // Check execPath
  if (execPath.includes('claude') && execPath.includes('desktop')) {
    return 'claude-desktop';
  }
  if (execPath.includes('claude') && execPath.includes('code')) {
    return 'claude-code';
  }
  if (execPath.includes('vscode') || execPath.includes('visual studio code')) {
    return 'vscode';
  }

  // Check process title
  if (processTitle.includes('claude desktop')) {
    return 'claude-desktop';
  }
  if (processTitle.includes('claude code')) {
    return 'claude-code';
  }
  if (processTitle.includes('vscode') || processTitle.includes('visual studio code')) {
    return 'vscode';
  }

  return null;
}

/**
 * Detect client from TERM_PROGRAM environment variable
 * @internal
 */
function detectFromTermProgram(): MCPClientType | null {
  if (!process.env.TERM_PROGRAM) {
    return null;
  }

  const termProgram = process.env.TERM_PROGRAM.toLowerCase();

  if (termProgram.includes('claude')) {
    if (termProgram.includes('desktop')) {
      return 'claude-desktop';
    }
    if (termProgram.includes('code')) {
      return 'claude-code';
    }
  }

  if (termProgram.includes('vscode')) {
    return 'vscode';
  }

  return null;
}

/**
 * Detect which MCP client is running the server
 *
 * Detection heuristics (in priority order):
 * 1. Environment variables (most reliable)
 * 2. Process arguments
 * 3. Process metadata (execPath and title)
 * 4. TERM_PROGRAM environment variable
 * 5. Unknown (fallback)
 *
 * @returns The detected MCP client type
 *
 * @example
 * ```typescript
 * const client = detectMCPClient();
 * console.log(`Running in: ${client}`);
 * // Output: "Running in: claude-code"
 * ```
 */
export function detectMCPClient(): MCPClientType {
  try {
    // FIX: Reduced cognitive complexity by extracting detection stages into helper functions
    // Previously: 28 (limit 15) - Now: much lower due to early returns in helpers
    return detectFromEnvironmentVariables() ??
           detectFromProcessArguments() ??
           detectFromProcessMetadata() ??
           detectFromTermProgram() ??
           'unknown';
  } catch {
    // Never throw errors - always return a valid result
    return 'unknown';
  }
}

/**
 * Get detailed client detection information for debugging
 *
 * @returns Object containing detected client and relevant environment info
 *
 * @example
 * ```typescript
 * const info = getClientDetectionInfo();
 * console.log(info);
 * // {
 * //   client: 'claude-code',
 * //   termProgram: 'claude-code',
 * //   hasVscodeEnv: false,
 * //   hasClaudeDesktopEnv: false
 * // }
 * ```
 */
export function getClientDetectionInfo(): {
  client: MCPClientType;
  termProgram?: string;
  hasVscodeEnv: boolean;
  hasClaudeDesktopEnv: boolean;
  hasClaudeCodeEnv: boolean;
  processTitle?: string;
  execPath?: string;
} {
  try {
    const client = detectMCPClient();

    return {
      client,
      termProgram: process.env.TERM_PROGRAM,
      hasVscodeEnv: !!(
        process.env.VSCODE_CWD ||
        process.env.VSCODE_PID ||
        process.env.VSCODE_IPC_HOOK
      ),
      hasClaudeDesktopEnv: !!(
        process.env.CLAUDE_DESKTOP ||
        process.env.CLAUDE_DESKTOP_VERSION
      ),
      hasClaudeCodeEnv: !!(
        process.env.CLAUDE_CODE ||
        (process.env.TERM_PROGRAM === 'claude-code')
      ),
      processTitle: process.title,
      execPath: process.execPath
    };
  } catch {
    // Never throw - return minimal safe info
    return {
      client: 'unknown',
      hasVscodeEnv: false,
      hasClaudeDesktopEnv: false,
      hasClaudeCodeEnv: false
    };
  }
}

/**
 * Check if running in a specific MCP client
 *
 * @param client - The client type to check for
 * @returns True if running in the specified client
 *
 * @example
 * ```typescript
 * if (isRunningInClient('claude-code')) {
 *   console.log('Running in Claude Code');
 * }
 * ```
 */
export function isRunningInClient(client: MCPClientType): boolean {
  try {
    return detectMCPClient() === client;
  } catch {
    return false;
  }
}
