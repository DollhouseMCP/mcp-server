/**
 * Best-effort MCP client platform detection for session metadata.
 *
 * This is intentionally conservative: when we cannot identify the host
 * confidently, we return null rather than guessing from a session ID.
 */

export type SessionClientPlatformId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'gemini-cli'
  | 'cline'
  | 'lmstudio'
  | 'web-console';

const CLIENT_PLATFORM_LABELS: Record<SessionClientPlatformId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  'gemini-cli': 'Gemini CLI',
  cline: 'Cline',
  lmstudio: 'LM Studio',
  'web-console': 'Web Console',
};

function normalizeText(value: string | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function matchesAnySource(values: readonly string[], needles: readonly string[]): boolean {
  return values.some((value) => includesAny(value, needles));
}

const TEXT_PLATFORM_MATCHERS: ReadonlyArray<{
  platform: SessionClientPlatformId;
  needles: readonly string[];
}> = [
  { platform: 'cursor', needles: ['cursor'] },
  { platform: 'windsurf', needles: ['windsurf'] },
  { platform: 'gemini-cli', needles: ['gemini'] },
  { platform: 'cline', needles: ['cline'] },
  { platform: 'lmstudio', needles: ['lmstudio', 'lm studio'] },
  { platform: 'claude-desktop', needles: ['claude desktop'] },
  { platform: 'claude-code', needles: ['claude code'] },
  { platform: 'codex', needles: ['codex'] },
];

export function normalizeSessionClientPlatformId(
  value: string | null | undefined,
): SessionClientPlatformId | null {
  const normalized = normalizeText(value ?? undefined);
  if (!normalized) {
    return null;
  }

  if (normalized === 'gemini') {
    return 'gemini-cli';
  }

  if (normalized in CLIENT_PLATFORM_LABELS) {
    return normalized as SessionClientPlatformId;
  }

  return null;
}

export function getSessionClientPlatformLabel(
  platform: SessionClientPlatformId | null | undefined,
): string {
  return platform ? CLIENT_PLATFORM_LABELS[platform] ?? '' : '';
}

export function detectSessionClientPlatformId(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
  title: string = process.title,
): SessionClientPlatformId | null {
  const termProgram = normalizeText(env.TERM_PROGRAM);
  const argvText = normalizeText(argv.join(' '));
  const execPathText = normalizeText(execPath);
  const titleText = normalizeText(title);
  const textSources = [argvText, execPathText, titleText];

  if (env.CLAUDE_DESKTOP === 'true' || env.CLAUDE_DESKTOP_VERSION) {
    return 'claude-desktop';
  }

  if (env.CLAUDE_CODE === 'true' || termProgram === 'claude-code') {
    return 'claude-code';
  }

  if (
    env.VSCODE_CWD ||
    env.VSCODE_PID ||
    env.VSCODE_IPC_HOOK ||
    env.VSCODE_NLS_CONFIG ||
    termProgram === 'vscode'
  ) {
    return 'vscode';
  }

  if (env.CODEX_HOME || termProgram === 'codex') {
    return 'codex';
  }

  for (const matcher of TEXT_PLATFORM_MATCHERS) {
    if (matchesAnySource(textSources, matcher.needles)) {
      return matcher.platform;
    }
  }

  return null;
}
