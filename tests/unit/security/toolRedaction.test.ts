import { describe, expect, it } from '@jest/globals';
import { getApprovableToolNames } from '../../../src/security/approvableTools.js';
import { TOOL_REDACTION, canonicalJSON, redactToolInput } from '../../../src/security/toolRedaction.js';
import { StaticAuditHmacKeyResolver } from '../../../src/security/auditHmacKey.js';

const resolver = new StaticAuditHmacKeyResolver('11'.repeat(32));
const REDACTED = '[REDACTED]';

describe('toolRedaction', () => {
  it('has explicit registry coverage for built-in approvable tools', () => {
    for (const toolName of getApprovableToolNames()) {
      expect(TOOL_REDACTION[toolName]).toBeDefined();
    }
  });

  it('redacts digestFields and hashes canonical raw input', async () => {
    const a = await redactToolInput('Bash', { command: 'npm test', description: 'run tests' }, resolver);
    const b = await redactToolInput('Bash', { description: 'run tests', command: 'npm test' }, resolver);

    expect(a.digest.command).toEqual({ redacted: true, type: 'string', length: 8 });
    expect(a.digest.description).toBe('run tests');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^static:[0-9a-f]{64}$/);
  });

  it('generic fallback catches embedded secret-shaped substrings', async () => {
    const redacted = await redactToolInput('UnknownTool', {
      command: `aws configure set aws_access_key_id ${'AKIA'}1234567890ABCDEF`,
      url: 'https://api.example.test/x?api_key=secret-value&ok=yes',
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
    }, resolver);

    expect(redacted.digest.command).toBe(REDACTED);
    expect(redacted.digest.authorization).toBe(REDACTED);
    expect(String(redacted.digest.url)).toContain('api_key=%5BREDACTED%5D');
    expect(String(redacted.digest.url)).toContain('ok=yes');
  });

  it('redacts nested secret fields without collapsing sibling forensic context', async () => {
    const redacted = await redactToolInput('UnknownTool', {
      params: {
        name: 'deploy-prod',
        token: `${'ghp'}_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ`,
        nested: { safe: 'kept', value: `${'sk'}_live_abcdefghijklmnopqrstuvwxyz` },
      },
    }, resolver);

    expect(redacted.digest.params).toEqual({
      name: 'deploy-prod',
      token: REDACTED,
      nested: { safe: 'kept', value: REDACTED },
    });
  });

  it('scrubs sensitive query params from non-absolute URL strings', async () => {
    const queryOnly = await redactToolInput('UnknownTool', { url: '?api_key=secret&ok=yes' }, resolver);
    const hostPath = await redactToolInput('UnknownTool', { url: 'example.com/x?token=secret&ok=yes' }, resolver);

    expect(queryOnly.digest.url).toBe('?api_key=%5BREDACTED%5D&ok=yes');
    expect(hostPath.digest.url).toBe('example.com/x?token=%5BREDACTED%5D&ok=yes');
  });

  it('HMAC differs across deployments with different keys', async () => {
    const input = { command: 'npm test' };
    const r2 = new StaticAuditHmacKeyResolver('22'.repeat(32));
    const r3 = new StaticAuditHmacKeyResolver('33'.repeat(32));
    const first = await redactToolInput('Bash', input, r2);
    const second = await redactToolInput('Bash', input, r3);

    expect(first.hash).not.toBe(second.hash);
  });

  it('keepFields run through pattern detection — secret-shaped values do NOT survive smuggling via description', async () => {
    // Reviewer finding 2026-05-22: keep values were previously trusted to
    // be safe and only length-capped. That let an attacker smuggle secrets
    // into the audit log by embedding them in Bash.description / WebFetch.prompt.
    // Now keep values go through redactString first.
    const redacted = await redactToolInput('Bash', {
      description: `deploy with ${'AKIA'}1234567890ABCDEF`,
      command: 'echo ok',
    }, resolver);

    expect(redacted.digest.description).toBe(REDACTED);
  });

  it('keepFields preserve innocuous content unchanged (no false positive on plain text)', async () => {
    const redacted = await redactToolInput('Bash', {
      description: 'run unit tests',
      command: 'npm test',
    }, resolver);

    expect(redacted.digest.description).toBe('run unit tests');
  });

  it('keepFields apply length cap on long innocuous content', async () => {
    // Use a non-hex character so the long-hex detector doesn't trip — the
    // intent of this test is the cap, not the secret-pattern path.
    const value = 'z'.repeat(500);
    const redacted = await redactToolInput('Bash', {
      description: value,
      command: 'echo ok',
    }, resolver);

    expect(String(redacted.digest.description)).toContain('[truncated,');
    expect((redacted.digest.description as string).length).toBeLessThan(value.length);
  });

  it('scrubs URL userinfo (HTTP-Basic credentials) from URL values', async () => {
    const redacted = await redactToolInput('UnknownTool', {
      target: 'https://alice:hunter2@api.example.test/users',
    }, resolver);

    expect(String(redacted.digest.target)).not.toContain('hunter2');
    expect(String(redacted.digest.target)).not.toContain('alice');
    expect(String(redacted.digest.target)).toContain('api.example.test/users');
  });

  it('scrubs URL userinfo inside keepFields too (no smuggle path)', async () => {
    const redacted = await redactToolInput('WebFetch', {
      url: 'https://bob:s3cret@api.example.test/?q=ok',
      prompt: 'summarize',
    }, resolver);

    // url is a digestField → opaque marker (no value leak there).
    expect(redacted.digest.url).toEqual({ redacted: true, type: 'string', length: 41 });
    // prompt is a keepField — verify userinfo isn't smuggleable through it.
    const redactedPrompt = await redactToolInput('WebFetch', {
      url: 'https://example.test',
      prompt: 'visit https://bob:s3cret@api.example.test/',
    }, resolver);
    expect(String(redactedPrompt.digest.prompt)).not.toContain('s3cret');
    expect(String(redactedPrompt.digest.prompt)).not.toContain('bob');
  });

  it('canonicalJSON is stable for nested object key order', () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJSON({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('canonicalJSON skips undefined values so explicit-vs-implicit absence hashes identically', () => {
    expect(canonicalJSON({ a: 1, b: undefined, c: 2 })).toBe(canonicalJSON({ a: 1, c: 2 }));
    expect(canonicalJSON([1, undefined, 2])).toBe('[1,null,2]');
  });
});
