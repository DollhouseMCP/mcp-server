/** Small polling primitives shared by session surfaces. */

export function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

/** Ignore completions from requests superseded by a newer request or teardown. */
export function createRequestOwner() {
  let generation = 0;
  return Object.freeze({
    claim() {
      generation += 1;
      return generation;
    },
    owns(claim) {
      return claim === generation;
    },
    invalidate() {
      generation += 1;
    },
  });
}

export function createVisiblePoller(task, { intervalMs = 5_000, onError = () => {} } = {}) {
  let active = false;
  let timer;
  let controller;
  let running = false;

  const schedule = () => {
    if (!active) return;
    timer = globalThis.setTimeout(run, intervalMs);
  };

  const run = async () => {
    if (!active || running) return;
    running = true;
    controller = new AbortController();
    try {
      await task(controller.signal);
    } catch (error) {
      if (!isAbortError(error)) onError(error);
    } finally {
      controller = undefined;
      running = false;
      schedule();
    }
  };

  return Object.freeze({
    start({ immediate = true } = {}) {
      if (active) return;
      active = true;
      if (immediate) run().catch(onError);
      else schedule();
    },
    stop() {
      active = false;
      if (timer !== undefined) globalThis.clearTimeout(timer);
      timer = undefined;
      controller?.abort();
    },
    refresh() {
      if (!active) return;
      if (timer !== undefined) globalThis.clearTimeout(timer);
      timer = undefined;
      run().catch(onError);
    },
  });
}

/**
 * @typedef {{ status: string, error_code?: string | null }} PollStatus
 * @typedef {{
 *   signal?: AbortSignal,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   onUpdate?: (status: PollStatus) => void,
 * }} PollUntilTerminalOptions
 */

/**
 * @param {(signal?: AbortSignal) => Promise<unknown>} readStatus
 * @param {PollUntilTerminalOptions} [options]
 * @returns {Promise<{ timedOut: boolean, status: PollStatus | null }>}
 */
export async function pollUntilTerminal(
  readStatus,
  { signal, intervalMs = 500, timeoutMs = 10_000, onUpdate = () => {} } = {},
) {
  const deadline = Date.now() + timeoutMs;
  /** @type {PollStatus | null} */
  let latest = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const status = await readStatus(signal);
    if (!isPollStatus(status)) {
      throw new TypeError('Polling status response must include a non-empty status.');
    }
    latest = status;
    onUpdate(latest);
    if (latest.status !== 'pending') {
      return { timedOut: false, status: latest };
    }
    await abortableDelay(intervalMs, signal);
  }
  return { timedOut: true, status: latest };
}

/**
 * @param {unknown} value
 * @returns {value is PollStatus}
 */
function isPollStatus(value) {
  return value !== null &&
    typeof value === 'object' &&
    typeof value.status === 'string' &&
    value.status.length > 0;
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      globalThis.clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function abortError() {
  const error = new Error('Polling aborted.');
  error.name = 'AbortError';
  return error;
}
