import { describe, expect, it } from '@jest/globals';
import { captureHostedStopOutput } from '../../integration/database/fixtures/hosted-stop-output.js';

describe('owned stop-helper failure output', () => {
  it('retains exact public helper messages across chunks and supports empty output', () => {
    const output = captureHostedStopOutput();
    expect(output.snapshot().stderr).toEqual({ text: '', observedBytes: 0, truncated: false, redacted: false });
    output.stdout(Buffer.from('Old process closed ')); output.stdout(Buffer.from('cleanly\n'));
    output.stderr(Buffer.from('Graceful stop refused or timed out; '));
    output.stderr(Buffer.from('old process retained, replacement refused\n'));
    expect(output.snapshot().stdout.text).toBe('Old process closed cleanly');
    expect(output.snapshot().stderr.text).toBe('Graceful stop refused or timed out; old process retained, replacement refused');
    expect(output.snapshot().stderr.redacted).toBe(false);
  });

  it('redacts credentials, URLs, tokens and mixed known/unrecognized output wholesale', () => {
    const output = captureHostedStopOutput();
    const sensitive = 'https://fixture-user:fixture-password@example.invalid/?token=fixture-token eyJfixture.payload.signature';
    output.stdout(Buffer.from(sensitive));
    output.stderr(Buffer.from('Memory obligations remain; replacement refused\n' + sensitive));
    for (const stream of Object.values(output.snapshot())) {
      expect(stream.text).toBe('[unrecognized helper output redacted]');
      expect(stream.redacted).toBe(true);
      expect(stream.text).not.toContain('fixture-');
    }
  });

  it('bounds retained bytes and refuses truncated output even when its prefix looks known', () => {
    const output = captureHostedStopOutput();
    const prefix = 'Old process closed cleanly';
    output.stdout(Buffer.from(prefix + ' '.repeat(1024)));
    output.stdout(Buffer.from('private-tail'));
    const stream = output.snapshot().stdout;
    expect(stream.observedBytes).toBe(Buffer.byteLength(prefix) + 1024 + Buffer.byteLength('private-tail'));
    expect(stream.truncated).toBe(true);
    expect(stream.redacted).toBe(true);
    expect(stream.text).toBe('[unrecognized helper output redacted]');
    expect(Buffer.byteLength(JSON.stringify(output.snapshot()))).toBeLessThan(512);
  });
});
