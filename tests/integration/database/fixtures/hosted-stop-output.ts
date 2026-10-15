/** Only public, fixed hosted-graceful-stop messages may reach failure logs. */
const PREFIX_BYTES = 1024;
const stdoutMessages = new Set(['Old process closed cleanly']);
const stderrMessages = new Set([
  'Container boot changed during drain; replacement refused',
  'Container boot identity unavailable; replacement refused',
  'Container identity or state changed; replacement refused',
  'Container is restarting; replacement refused',
  'Container state unavailable; replacement refused',
  'Container storage identity unavailable; replacement refused',
  'Docker command deadline reached; replacement refused',
  'Docker command failed; replacement refused',
  'Docker response exceeded metadata bound; replacement refused',
  'Docker unavailable; replacement refused',
  'Drain acknowledgement exceeded bound; replacement refused',
  'Drain acknowledgement identity changed; replacement refused',
  'Drain acknowledgement unavailable; replacement refused',
  'Drain boot binding unavailable; replacement refused',
  'Drain hold must use the private container layer; replacement refused',
  'Graceful stop deadline reached; replacement refused',
  'Graceful stop refused or timed out; old process retained, replacement refused',
  'Image or profile does not support verified memory drain; replacement refused',
  'Invalid immutable container ID or graceful-stop deadline',
  'Memory obligations remain; replacement refused',
  'Old process did not close cleanly; replacement refused',
  'Stopped container has no live drain acknowledgement; replacement refused',
  'Verified memory drain or clean closure unavailable; replacement refused',
]);

export function captureHostedStopOutput() {
  const stdout = { prefix: Buffer.alloc(0), bytes: 0 };
  const stderr = { prefix: Buffer.alloc(0), bytes: 0 };
  const append = (stream: typeof stdout, chunk: Buffer) => {
    stream.bytes += chunk.length;
    const remaining = PREFIX_BYTES - stream.prefix.length;
    if (remaining > 0) stream.prefix = Buffer.concat([stream.prefix, chunk.subarray(0, remaining)]);
  };
  const snapshot = (stream: typeof stdout, allowed: ReadonlySet<string>) => {
    const value = stream.prefix.toString('utf8');
    let message: string | undefined;
    if (value.endsWith('\r\n')) message = value.slice(0, -2);
    else if (value.endsWith('\n')) message = value.slice(0, -1);
    const truncated = stream.bytes > stream.prefix.length;
    const redacted = truncated || (value.length > 0 && (message === undefined || !allowed.has(message)));
    return { text: redacted ? '[unrecognized helper output redacted]' : message ?? '',
      observedBytes: stream.bytes, truncated, redacted };
  };
  return {
    stdout: (chunk: Buffer) => append(stdout, chunk),
    stderr: (chunk: Buffer) => append(stderr, chunk),
    snapshot: () => ({ stdout: snapshot(stdout, stdoutMessages), stderr: snapshot(stderr, stderrMessages) }),
  };
}
