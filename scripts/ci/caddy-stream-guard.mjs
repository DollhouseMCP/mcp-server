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
    stderrTail: stderr.slice(-4096).replace(/[^\x20-\x7e\n]/g, '?'),
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

// Diagnostics are limited to the two exact containers created by this run.
export function collectOwnedDiagnostics(ids, owned, run) {
  if (!Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !owned.includes(id))) {
    return { error: 'invalid-owned-diagnostic-targets' };
  }
  const bounded = value => String(value ?? '').slice(0, 65536);
  return ids.map(id => {
    const entry = { id };
    try {
      const state = run(['inspect', '--format', '{{json .State}}', id]);
      if (state.error || state.status !== 0) throw new Error('inspect-failed');
      const raw = JSON.parse(bounded(state.stdout));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-state');
      entry.state = Object.fromEntries(['Running', 'Status', 'ExitCode', 'OOMKilled', 'Dead', 'Error', 'StartedAt', 'FinishedAt']
        .filter(key => ['string', 'number', 'boolean'].includes(typeof raw[key]))
        .map(key => [key, typeof raw[key] === 'string' ? raw[key].slice(0, 1024) : raw[key]]));
    } catch { entry.stateError = 'unavailable'; }
    try {
      const logs = run(['logs', '--tail', '80', id]);
      entry.logs = { status: logs.status, stdout: bounded(logs.stdout), stderr: bounded(logs.stderr),
        error: logs.error ? 'unavailable' : undefined };
    } catch { entry.logs = { error: 'unavailable' }; }
    return entry;
  });
}

export function clientExecFailure(options, error, elapsedMs) {
  const stderr = String(error.stderr ?? '');
  return JSON.stringify({ phase:'client-exec-failed', protocol:options.h2 ? 'h2' : 'http/1.1',
    method:options.method ?? 'GET', elapsedMs, stdoutBytes:Buffer.byteLength(String(error.stdout ?? '')),
    stderrBytes:Buffer.byteLength(stderr), stderrTail:stderr.slice(-4096).replace(/[^\x20-\x7e\n]/g, '?') });
}
