// Track the response's terminal events without treating partial data as success.
export function observeStream(stream, fail) {
  let ended = false;
  let failed = false;
  const refuse = (reason, error) => {
    if (ended || failed) return;
    failed = true;
    fail(reason, error);
  };
  stream.once('end', () => { ended = true; });
  stream.once('aborted', () => refuse('response-aborted'));
  stream.once('error', error => refuse('response-error', error));
  stream.once('close', () => {
    if (!ended) refuse('response-closed-before-end');
  });
}

export function observeUnsettledExit(processObject, isSettled, fail) {
  processObject.once('beforeExit', () => {
    if (!isSettled()) fail('client-exited-before-completion');
  });
}

export function observeRequestClose(request, hasResponse, fail) {
  request.once('close', () => {
    if (!hasResponse()) fail('request-closed-before-response');
  });
}

export function parseClientOutput(options, result, elapsedMs) {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const diagnostic = {
    protocol: options.h2 ? 'h2' : 'http/1.1', method: options.method ?? 'GET', elapsedMs,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    stderrTail: stderr.slice(-512).replace(/[^\x20-\x7e\n]/g, '?'),
  };
  if (!stdout.trim()) throw new Error(JSON.stringify({ phase: 'engine-empty-output', ...diagnostic }));
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(JSON.stringify({ phase: 'engine-invalid-output', ...diagnostic }));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(JSON.stringify({ phase: 'engine-invalid-output', ...diagnostic }));
  }
  return value;
}
