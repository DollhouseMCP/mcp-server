// Jest setup file for global test configuration

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PERSONAS_DIR = 'test-personas';

// Use discrete mode for tests - integration tests use individual tools like activate_element
// Production default is 'mcpaql' but tests need discrete tools to be registered
process.env.MCP_INTERFACE_MODE = 'discrete';

// ── Real MCP-client-config pollution guard (issue #2338) ─────────────────────
// A unit test must never patch a user's REAL MCP client config. The NVM
// mitigation helpers in src/web/routes/setupRoutes.ts resolve those paths from
// os.homedir(); a test that forgets to inject a fake home / configPathOverride
// silently rewrites the developer's Claude Desktop / Cursor / Windsurf / LM
// Studio / Gemini CLI / Claude Code config to point at a temp-dir wrapper that
// is then deleted, breaking those apps.
//
// Design constraints on this machine:
//   • ESM named imports of node:fs cannot be monkeypatched, so we cannot
//     intercept the write itself.
//   • Some of these files are LIVE app state that changes on its own during a
//     test run (e.g. ~/.claude.json is rewritten by the running Claude Code /
//     Claude Desktop). So we must NOT diff for "any change" (ambient churn would
//     false-positive) and must NEVER write to these files (restoring stale bytes
//     over live state would corrupt it).
//
// Instead we detect the unambiguous #2338 *pollution signature* after each test:
// a dollhousemcp `command` that points under os.tmpdir(), or at a
// `dollhousemcp-nvm.sh` wrapper that does not exist. No real app produces that;
// only a leaking test does. Detect-only, read-only, prefix-independent.
import { homedir, platform, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Mirror of getConfigPath() in src/web/routes/setupRoutes.ts for EVERY client the
// install/open-config endpoints can resolve — not just the JSON NVM clients. Kept
// in lockstep with that resolver so the guard covers every real config setup can
// write (Cline, VS Code, Codex included). It can't import the compiled TS here, so
// the mapping is replicated; a drift would only make the guard miss a path, never
// false-positive.
const REAL_CLIENT_CONFIG_PATHS = (() => {
  const home = homedir();
  const plat = platform();
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const codeUserDir = plat === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Code', 'User')
    : plat === 'win32'
      ? join(appData, 'Code', 'User')
      : join(home, '.config', 'Code', 'User');
  const claudeDesktop = plat === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : plat === 'win32'
      ? join(appData, 'Claude', 'claude_desktop_config.json')
      : join(home, '.config', 'Claude', 'claude_desktop_config.json');
  return [
    claudeDesktop,                                              // Claude Desktop
    join(home, '.claude.json'),                                 // Claude Code
    join(home, '.cursor', 'mcp.json'),                          // Cursor
    join(codeUserDir, 'settings.json'),                         // VS Code
    join(codeUserDir, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), // Cline
    join(home, '.codeium', 'windsurf', 'mcp_config.json'),      // Windsurf
    join(home, '.lmstudio', 'mcp.json'),                        // LM Studio
    join(home, '.gemini', 'settings.json'),                     // Gemini CLI
    join(home, '.codex', 'config.toml'),                        // Codex (TOML — parse-skipped, listed for completeness)
  ];
})();

/**
 * Returns a reason string if the dollhousemcp entry in a real client config
 * looks like #2338 test pollution, or null otherwise. Read-only.
 */
function detectConfigPollution(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return null; // absent/unreadable — nothing to inspect
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // not JSON (or mid-write by a live app) — ignore
  }
  const tmp = tmpdir();
  for (const key of ['mcpServers', 'servers']) {
    const command = parsed?.[key]?.dollhousemcp?.command;
    if (typeof command !== 'string') continue;
    if (command === tmp || command.startsWith(tmp + sep)) {
      return `dollhousemcp.command points under os.tmpdir(): ${command}`;
    }
    if (command.endsWith('dollhousemcp-nvm.sh') && !existsSync(command)) {
      return `dollhousemcp.command points at a missing NVM wrapper: ${command}`;
    }
  }
  return null;
}

afterEach(() => {
  const violations = [];
  for (const p of REAL_CLIENT_CONFIG_PATHS) {
    const reason = detectConfigPollution(p);
    if (reason) violations.push(`  - ${p} — ${reason}`);
  }

  if (violations.length > 0) {
    const testName = expect.getState().currentTestName ?? '(unknown test)';
    throw new Error(
      `[#2338 guard] A unit test polluted a real MCP client config:\n` +
      violations.join('\n') +
      `\nTest: ${testName}\n` +
      `Route config writes to a temp dir by injecting a fake home / ` +
      `configPathOverride (see setupRoutes NVM helpers). The real file was left ` +
      `untouched by this guard — repair it if the leak actually landed.`,
    );
  }
});