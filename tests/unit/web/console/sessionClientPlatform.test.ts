import { describe, expect, it } from '@jest/globals';
import {
  detectSessionClientPlatformId,
  getSessionClientPlatformLabel,
  normalizeSessionClientPlatformId,
} from '../../../../src/web/console/sessionClientPlatform.js';

describe('sessionClientPlatform', () => {
  it('normalizes supported platform IDs', () => {
    expect(normalizeSessionClientPlatformId('claude-code')).toBe('claude-code');
    expect(normalizeSessionClientPlatformId('gemini')).toBe('gemini-cli');
    expect(normalizeSessionClientPlatformId('unknown-client')).toBeNull();
  });

  it('returns human labels for known platforms', () => {
    expect(getSessionClientPlatformLabel('claude-code')).toBe('Claude Code');
    expect(getSessionClientPlatformLabel('web-console')).toBe('Web Console');
    expect(getSessionClientPlatformLabel(null)).toBe('');
  });

  it('detects Claude Code from TERM_PROGRAM', () => {
    const detected = detectSessionClientPlatformId(
      { TERM_PROGRAM: 'claude-code' },
      ['node', 'dist/index.js'],
      '/usr/local/bin/node',
      'node',
    );
    expect(detected).toBe('claude-code');
  });

  it('detects Codex from CODEX_HOME', () => {
    const detected = detectSessionClientPlatformId(
      { CODEX_HOME: '/Users/test/.codex' },
      ['node', 'dist/index.js'],
      '/usr/local/bin/node',
      'node',
    );
    expect(detected).toBe('codex');
  });

  it('detects Gemini CLI from argv text when no explicit env markers exist', () => {
    const detected = detectSessionClientPlatformId(
      {},
      ['node', '/Applications/Gemini CLI.app/Contents/MacOS/gemini'],
      '/usr/local/bin/node',
      'node',
    );
    expect(detected).toBe('gemini-cli');
  });

  it('returns null when the host cannot be identified confidently', () => {
    const detected = detectSessionClientPlatformId(
      {},
      ['node', 'dist/index.js'],
      '/usr/local/bin/node',
      'node',
    );
    expect(detected).toBeNull();
  });
});
