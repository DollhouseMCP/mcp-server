import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { observeStream, waitForStreamRetirement, SessionIdleExpiry } from '../../../src/server/http/StreamLifecycle.js';
import { SseStallWatcher } from '../../../src/server/http/SseStallWatcher.js';

function response() {
  const emitter = new EventEmitter();
  const state = Object.assign(emitter, {
    headersSent: true, statusCode: 200, writableEnded: false, destroyed: false, writableNeedDrain: false,
    contentType: 'text/event-stream; charset=utf-8',
    getHeader: () => state.contentType,
    write: jest.fn((_chunk: unknown) => true),
    end: jest.fn((_chunk?: unknown) => state),
    destroy: jest.fn(() => { state.destroyed = true; state.emit('close'); return state; }),
  });
  return { state, res: state as unknown as ServerResponse };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); jest.spyOn(Math, 'random').mockReturnValue(0.5); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('stream observation and idle expiry', () => {
  it('cancels expiry on open, ignores old close, restarts full grace on final close, and POST extends grace', () => {
    const expire = jest.fn(); const old = response(); const next = response();
    const idle = new SessionIdleExpiry(100, () => true, expire);
    idle.touch(); jest.advanceTimersByTime(90); idle.open(old.res);
    jest.advanceTimersByTime(200); expect(expire).not.toHaveBeenCalled();
    idle.touch(); expect(jest.getTimerCount()).toBe(0);
    idle.open(next.res); expect(idle.close(old.res)).toBe(false);
    expect(idle.close(next.res)).toBe(true);
    jest.advanceTimersByTime(90); idle.touch(); jest.advanceTimersByTime(90);
    expect(expire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(10); expect(expire).toHaveBeenCalledTimes(1);
    idle.dispose();
  });

  it('rechecks a stale queued callback and rearms for the remaining grace', () => {
    const timers = jest.spyOn(globalThis, 'setTimeout'); const expire = jest.fn();
    const idle = new SessionIdleExpiry(100, () => true, expire);
    idle.touch(); const callback = timers.mock.calls.at(-1)![0];
    jest.advanceTimersByTime(60); idle.touch();
    if (typeof callback === 'function') callback();
    jest.advanceTimersByTime(40); expect(expire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60); expect(expire).toHaveBeenCalledTimes(1);
    idle.dispose(); timers.mockRestore();
  });

  it('reconnect cancels grace; disposal, changed identity and zero timeout cannot expire', () => {
    const expire = jest.fn(); let current = true;
    const idle = new SessionIdleExpiry(100, () => current, expire); const { res } = response();
    idle.open(res); idle.close(res); jest.advanceTimersByTime(50); idle.open(res);
    jest.advanceTimersByTime(200); expect(expire).not.toHaveBeenCalled();
    idle.close(res); current = false; jest.advanceTimersByTime(200);
    expect(expire).not.toHaveBeenCalled(); idle.dispose(); idle.touch();
    new SessionIdleExpiry(0, () => true, expire).touch();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([400, 403, 406, 409, 429, 503])('never accepts a rejected %s GET', code => {
    const { state, res } = response(); state.statusCode = code;
    const onOpen = jest.fn(); const onClose = jest.fn();
    observeStream(res, { isCurrent: () => true, onOpen, onClose });
    jest.advanceTimersByTime(5); state.emit('close');
    expect(onOpen).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('destroys a response if disposed between SDK acceptance and header observation', () => {
    const { state, res } = response(); const onOpen = jest.fn();
    observeStream(res, { isCurrent: () => false, onOpen, onClose: jest.fn() });
    jest.advanceTimersByTime(5);
    expect(state.destroyed).toBe(true); expect(onOpen).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0])('keeps a non-expiring stream open without a cap (%s)', maxLifetimeMs => {
    const { state, res } = response(); const onClose = jest.fn();
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose, maxLifetimeMs });
    jest.advanceTimersByTime(60 * 60_000);
    expect(observation.accepted).toBe(true); expect(state.destroyed).toBe(false);
    expect(onClose).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
    state.emit('close'); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 0, 100])('gates payloads at expiry without closing; optional cap %s still closes', maxLifetimeMs => {
    const { state, res } = response(); const writes = state.write;
    const onExpired = jest.fn(); const onClose = jest.fn();
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose, onCredentialExpired: onExpired, expiresAt: 50, maxLifetimeMs });
    observation.inspect();
    jest.advanceTimersByTime(49);
    expect(res.write('event: message\ndata: {"jsonrpc":"2.0"}\n\n')).toBe(true);
    expect(writes).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    res.write('event: message\ndata: {"jsonrpc":"2.0"}\n\n');
    res.write(': keepalive\n\n');
    expect(writes).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenLastCalledWith(': keepalive\n\n', undefined);
    expect(onExpired).toHaveBeenCalledTimes(1); expect(state.destroyed).toBe(false);
    jest.advanceTimersByTime(49); expect(state.destroyed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(state.destroyed).toBe(maxLifetimeMs === 100);
    expect(onClose).toHaveBeenCalledTimes(maxLifetimeMs === 100 ? 1 : 0);
    observation.stop(); expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    'event: message\ndata: {"method":"notifications/tools/list_changed"}\n\n',
    Buffer.from('event: message\ndata: {"id":1,"method":"ping"}\n\n'),
    new TextEncoder().encode('event: message\ndata: {"id":1,"result":{}}\n\n'),
    ': keepalive\n\nevent: message\ndata: {}\n\n',
    new TextEncoder().encode(': keepalive\n\nevent: message\ndata: {}\n\n'),
    new TextEncoder().encode(': keepalive\n'),
    ':hb\n\n',
  ])('drops all expired MCP writes including binary and mixed frames (%s)', chunk => {
    const { state, res } = response(); const writes = state.write; const done = jest.fn();
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: 50 });
    // Jump the clock without firing timers: the write boundary must still gate.
    jest.setSystemTime(50);
    expect(res.write(chunk, done)).toBe(true);
    expect(writes).not.toHaveBeenCalled(); expect(state.destroyed).toBe(false);
    jest.runAllTicks(); expect(done).toHaveBeenCalledTimes(1);
    observation.stop(); expect(res.write).toBe(writes); expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves write callbacks, encoding and backpressure before expiry', () => {
    const { state, res } = response(); const writes = state.write; const done = jest.fn();
    writes.mockReturnValue(false);
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: 50 });
    expect(res.write('before', 'utf8', done)).toBe(false);
    expect(writes).toHaveBeenLastCalledWith('before', 'utf8', done);
    expect(res.write('before', done)).toBe(false);
    expect(writes).toHaveBeenLastCalledWith('before', done);
    expect(done).not.toHaveBeenCalled();
    observation.stop();
  });

  it('closes at an opt-in cap before a later credential expiry and cancels both timers', () => {
    const { state, res } = response(); const onExpired = jest.fn();
    observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: 100, maxLifetimeMs: 50, onCredentialExpired: onExpired }).inspect();
    jest.advanceTimersByTime(49); expect(state.destroyed).toBe(false);
    jest.advanceTimersByTime(1); expect(state.destroyed).toBe(true);
    expect(onExpired).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });

  it('drops end(data) but preserves completion and restores response methods on stop', () => {
    const { state, res } = response(); const end = state.end; const done = jest.fn();
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: -1 });
    expect(res.end('event: message\ndata: {}\n\n', 'utf8', done)).toBe(res);
    expect(end).toHaveBeenCalledWith(done);
    observation.stop(); expect(res.end).toBe(end); expect(jest.getTimerCount()).toBe(0);
  });

  it('passes error response bodies through even when the credential is expired', () => {
    const { state, res } = response(); state.statusCode = 403; const writes = state.write;
    observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: -1 });
    res.write('denied'); expect(writes).toHaveBeenCalledWith('denied', undefined);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('continues stall observation without app heartbeat writes after credential expiry', () => {
    const { state, res } = response(); const writes = state.write;
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: 50 });
    observation.inspect(); const stopStallWatcher = new SseStallWatcher(10).attach(res);
    jest.advanceTimersByTime(100);
    expect(writes).not.toHaveBeenCalled();
    expect(state.destroyed).toBe(false);
    stopStallWatcher(); observation.stop(); expect(jest.getTimerCount()).toBe(0);
  });

  it('rearms at the timer limit and closes exactly once at a distant opt-in cap', () => {
    jest.setSystemTime(10_000);
    const duration = 30 * 24 * 60 * 60_000;
    const { state, res } = response(); const onClose = jest.fn();
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose, maxLifetimeMs: duration });
    observation.inspect();
    jest.advanceTimersByTime(2_147_483_647);
    expect(state.destroy).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(duration - 2_147_483_647 - 1);
    expect(state.destroy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(state.destroy).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(duration); expect(state.destroy).toHaveBeenCalledTimes(1);
  });

  it('rearms distant credential expiry and gates only at its true deadline', () => {
    const { state, res } = response(); const writes = state.write; const onExpired = jest.fn();
    const expiresAt = 30 * 24 * 60 * 60_000;
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), onCredentialExpired: onExpired, expiresAt });
    observation.inspect(); jest.advanceTimersByTime(2_147_483_647);
    expect(onExpired).not.toHaveBeenCalled(); res.write('before'); expect(writes).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(expiresAt - 2_147_483_647);
    res.write('after'); expect(writes).toHaveBeenCalledTimes(1); expect(onExpired).toHaveBeenCalledTimes(1);
    expect(state.destroyed).toBe(false); observation.stop(); expect(jest.getTimerCount()).toBe(0);
  });

  it.each([0, 2_147_483_647])('stopping cancels both deadlines before or after rearming (%s)', elapsed => {
    const { state, res } = response(); const onExpired = jest.fn();
    const duration = 30 * 24 * 60 * 60_000;
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), onCredentialExpired: onExpired, expiresAt: duration, maxLifetimeMs: duration });
    observation.inspect(); jest.advanceTimersByTime(elapsed);
    observation.stop(); observation.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(duration);
    expect(state.destroy).not.toHaveBeenCalled(); expect(onExpired).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds uncommitted headers and cleans an early close without acceptance', () => {
    const { state, res } = response(); state.headersSent = false; const onOpen = jest.fn();
    observeStream(res, { isCurrent: () => true, onOpen, onClose: jest.fn() });
    jest.advanceTimersByTime(10_000); expect(state.destroyed).toBe(true);
    expect(onOpen).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
    const second = response(); second.state.headersSent = false;
    observeStream(second.res, { isCurrent: () => true, onOpen, onClose: jest.fn() });
    second.state.emit('close'); expect(jest.getTimerCount()).toBe(0);
  });
});

describe('stream credential renewal', () => {
  const binding = { sub: 'alice', issuer: 'issuer', clientId: 'client', authorizedParty: 'party', grantId: 'grant', sessionId: 'login' };
  function setup() {
    const { state, res } = response();
    const write = state.write;
    const onCredentialRenewed = jest.fn();
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: 50, binding, onCredentialRenewed });
    observation.inspect();
    return { state, res, write, observation, onCredentialRenewed };
  }

  it('extends monotonically, ignores missing/invalid expiration, and expires exactly at the new credential deadline', () => {
    const { res, write, observation } = setup();
    observation.renewCredential(100, binding);
    for (const expiry of [undefined, NaN, Infinity, 20, 100]) observation.renewCredential(expiry, binding);
    jest.advanceTimersByTime(99); res.write('allowed');
    expect(write).toHaveBeenCalledWith('allowed', undefined);
    jest.advanceTimersByTime(1); res.write('blocked');
    expect(write).toHaveBeenCalledTimes(1);
    observation.stop(); expect(jest.getTimerCount()).toBe(0);
  });

  it('un-gates once, requests one resync only after drops, and re-arms the expiry timer', () => {
    const { res, write, observation, onCredentialRenewed } = setup();
    jest.advanceTimersByTime(50); res.write('dropped'); res.write('also dropped');
    expect(write).not.toHaveBeenCalled();
    expect(observation.renewCredential(100, binding)).toBe(true);
    expect(observation.renewCredential(100, binding)).toBe(false);
    expect(onCredentialRenewed).toHaveBeenCalledTimes(1);
    res.write('renewed'); expect(write).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(50); res.write('dropped again');
    expect(write).toHaveBeenCalledTimes(1);
    expect(observation.renewCredential(150, binding)).toBe(true);
    expect(onCredentialRenewed).toHaveBeenCalledTimes(2);
    observation.stop(); expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['sub', 'issuer', 'clientId', 'authorizedParty', 'grantId', 'sessionId'] as const)('rejects changed or missing %s without disturbing the stream', field => {
    const { res, state, write, observation } = setup();
    jest.advanceTimersByTime(50);
    for (const value of ['different', undefined]) {
      const candidate = { ...binding, [field]: value };
      // Missing subject is invalid too; model it separately from optional claims.
      expect(observation.renewCredential(100, candidate as typeof binding)).toBe(false);
      res.write('blocked');
    }
    expect(write).not.toHaveBeenCalled(); expect(state.destroyed).toBe(false);
    observation.stop();
  });

  it('allows the available fallback binding but rejects adding a formerly absent claim', () => {
    const { res, state } = response(); const write = state.write;
    const observation = observeStream(res, { isCurrent: () => true, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: 50, binding: { sub: 'alice' } });
    observation.inspect(); jest.advanceTimersByTime(50);
    observation.renewCredential(100, { sub: 'alice', clientId: 'client' }); res.write('blocked');
    expect(write).not.toHaveBeenCalled();
    observation.renewCredential(100, { sub: 'alice' }); res.write('allowed');
    expect(write).toHaveBeenCalledTimes(1); observation.stop();
  });

  it('clamps distant renewed deadlines and stop cancels the rearmed timer', () => {
    const { res, write, observation } = setup();
    const deadline = 30 * 24 * 60 * 60 * 1000;
    observation.renewCredential(deadline, binding);
    jest.advanceTimersByTime(2_147_483_647); res.write('still allowed');
    expect(write).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(1);
    observation.stop(); expect(jest.getTimerCount()).toBe(0);
    expect(observation.renewCredential(deadline + 100, binding)).toBe(false);
  });

  it('does not resync on heartbeat-only expiry or renew a stale or unaccepted observer', () => {
    const { res, state } = response(); const writes = state.write; let current = true;
    const observation = observeStream(res, { isCurrent: () => current, onOpen: jest.fn(), onClose: jest.fn(), expiresAt: 50, binding });
    expect(observation.renewCredential(100, binding)).toBe(false);
    observation.inspect(); jest.advanceTimersByTime(50);
    res.write(new TextEncoder().encode(': keepalive\n\n'));
    res.write(': keepalive\n\n');
    expect(writes).toHaveBeenCalledTimes(2);
    expect(observation.renewCredential(100, binding)).toBe(false);
    current = false; expect(observation.renewCredential(150, binding)).toBe(false);
    observation.stop();
  });
});

describe('stream retirement', () => {
  it('bounds retirement without retaining a timer after normal completion', async () => {
    const stuck = waitForStreamRetirement(new Promise(() => {}));
    await jest.advanceTimersByTimeAsync(5000); await expect(stuck).resolves.toBe(false);
    await expect(waitForStreamRetirement(Promise.resolve())).resolves.toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
