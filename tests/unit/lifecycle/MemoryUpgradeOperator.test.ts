import { describe, it, expect, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MemoryUpgradeControlState } from '../../../src/lifecycle/MemoryUpgradeControlState.js';
import { MemoryUpgradeOperator } from '../../../src/lifecycle/MemoryUpgradeOperator.js';
import { MemoryUpgradeLifecycle } from '../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { requestMemoryDrain } from '../../../src/lifecycle/requestMemoryDrain.js';

const unix = process.platform === 'win32' ? describe.skip : describe;
const containerId = 'a'.repeat(64);
const nonce = 'b'.repeat(64);
const boot = 'c'.repeat(64);

async function owned(body: (directory: string) => Promise<void>, safeToRemove: () => boolean = () => true): Promise<void> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-control-unit-')));
  await fs.chmod(directory, 0o700);
  try { await body(directory); }
  finally {
    jest.restoreAllMocks();
    if (safeToRemove()) await fs.rm(directory, { recursive: true, force: true });
    else process.stderr.write(`Owned fixture retained because cleanup was not confirmed: ${directory}\n`);
  }
}

async function closeEmptyFixture(operator: MemoryUpgradeOperator): Promise<void> {
  // Only disposable library listeners with no actual root/owners. Never used by the product.
  const server = (operator as unknown as { server: net.Server }).server;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// Test-only coordination: an expired/refused client is not evidence that the
// server reached the held durable-intent boundary.
async function waitForIntentOrClient(intentEntered: Promise<void>, client: Promise<unknown>): Promise<void> {
  const first = await Promise.race([
    intentEntered.then(() => 'intent' as const),
    client.then(() => 'client' as const, () => 'client' as const),
  ]);
  if (first !== 'intent') throw new Error('fixture client settled before intent entry');
}

function reportCleanupFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 512) : 'unknown cleanup error';
  process.stderr.write(`Owned fixture cleanup failed after the primary test failure: ${detail}\n`);
}

async function cleanupHeldFixture(operator: MemoryUpgradeOperator, releaseIntent: () => void,
  releaseOriginal: () => void, original: Promise<unknown>, restoreIntent: () => void): Promise<void> {
  releaseIntent(); releaseOriginal();
  // Only this test's disposable listener and sockets are destroyed; no product
  // admission state or durable hold is changed to make teardown pass.
  const ownedOperator = operator as unknown as {
    server?: net.Server; sockets: Set<net.Socket>; drainAttempt?: Promise<unknown>;
  };
  for (const socket of ownedOperator.sockets) socket.destroy();
  const closing = ownedOperator.server?.listening ?
    new Promise<void>((resolve, reject) => ownedOperator.server!.close(error => error ? reject(error) : resolve())) : Promise.resolve();
  // Observe rejection immediately, even while listener closure is pending.
  const originalOutcome = original.then(() => ({ failed: false as const }), error => ({ failed: true as const, error }));
  const settle = async (): Promise<void> => {
    await closing;
    // Closing the listener prevents further socket intake, but does not join a
    // drain already in progress. Capture and join it after closure.
    const pending = ownedOperator.drainAttempt?.then(() => undefined, () => undefined);
    const [outcome] = await Promise.all([originalOutcome, pending ?? Promise.resolve()]);
    if (outcome.failed) throw outcome.error;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settle(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('owned fixture cleanup deadline')), 1000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); restoreIntent(); }
}

unix('Private memory admission control', () => {
  it('closes admission before held intent I/O and refuses an expired request without flushing original work', () => {
    let cleanupKnown = false;
    return owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    let releaseIntent = (): void => {};
    let releaseOriginal = (): void => {};
    let original: Promise<unknown> = Promise.resolve();
    let restoreIntent = (): void => {};
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    let failed = false;
    let cleanupFailed = false;
    try {
      operator.bindLifecycle(lifecycle); operator.enableOriginalDrain();
      await operator.listen();
      let enteredIntent!: () => void;
      const intentEntered = new Promise<void>(resolve => { enteredIntent = resolve; });
      const intentHeld = new Promise<void>(resolve => { releaseIntent = resolve; });
      const request = operator.state.request.bind(operator.state);
      const intent = jest.spyOn(operator.state, 'request').mockImplementation(async (...args) => {
        enteredIntent(); await intentHeld; return request(...args);
      });
      restoreIntent = () => intent.mockRestore();
      const originalHeld = new Promise<void>(resolve => { releaseOriginal = resolve; });
      original = lifecycle.runRequest(() => lifecycle.runWrite(() => originalHeld));
      const stopped = jest.fn();
      lifecycle.registerStopSource(stopped);
      const client = requestMemoryDrain(directory, containerId, nonce, 50);
      const refusal = expect(client).rejects.toThrow();
      // Keep an early failed matcher observed while preserving the original assertion.
      void refusal.catch(() => {});
      await waitForIntentOrClient(intentEntered, client);
      expect(lifecycle.getSummary()).toMatchObject({ state: 'quiescing', admitted: 1, writes: 1 });
      await expect(lifecycle.runRequest(async () => undefined)).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
      expect(stopped).not.toHaveBeenCalled();
      await refusal;
      releaseIntent();
      // Wait for the original server-side attempt, not a second drain/replay.
      const pending = (operator as unknown as { drainAttempt: Promise<unknown> }).drainAttempt;
      await expect(pending).rejects.toThrow('deadline');
      intent.mockRestore();
      expect(stopped).not.toHaveBeenCalled();
      expect((await operator.state.read()).kind).toBe('requested');
      expect(lifecycle.getSummary()).toMatchObject({ state: 'quiescing', admitted: 1, writes: 1 });
      releaseOriginal(); await original;
      const ack = await requestMemoryDrain(directory, containerId, nonce, 1000);
      expect(ack.phase).toBe('drained');
      expect(stopped).toHaveBeenCalledTimes(1);
      await operator.closeAfterDrain();
    } catch (error) {
      failed = true; primaryFailure = error;
    } finally {
      try {
        await cleanupHeldFixture(operator, releaseIntent, releaseOriginal, original, restoreIntent);
        cleanupKnown = true;
      } catch (error) { cleanupFailed = true; cleanupFailure = error; }
    }
    if (failed) {
      if (cleanupFailed) reportCleanupFailure(cleanupFailure);
      throw primaryFailure;
    }
    if (cleanupFailed) throw cleanupFailure;
    }, () => cleanupKnown);
  });

  it('fails promptly when a client deadline settles before intent entry', async () => {
    const intentNeverEntered = new Promise<void>(() => {});
    await expect(waitForIntentOrClient(intentNeverEntered, Promise.reject(new Error('Memory drain client deadline'))))
      .rejects.toThrow('fixture client settled before intent entry');
    await expect(waitForIntentOrClient(intentNeverEntered, Promise.resolve()))
      .rejects.toThrow('fixture client settled before intent entry');
  });

  it('fails promptly when the actual client deadline expires before intent entry', () => {
    let cleanupKnown = false;
    return owned(async directory => {
    let connected!: () => void;
    const accepted = new Promise<void>(resolve => { connected = resolve; });
    const sockets = new Set<net.Socket>();
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    let failed = false;
    let cleanupFailed = false;
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      connected(); // Deliberately withhold the hello response; no product server is mocked.
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path.join(directory, 'control.sock'), () => { server.off('error', reject); resolve(); });
      });
      const client = requestMemoryDrain(directory, containerId, nonce, 50);
      const neverEntered = new Promise<void>(() => {});
      await waitForIntentOrClient(accepted, client);
      await expect(waitForIntentOrClient(neverEntered, client)).rejects.toThrow('fixture client settled before intent entry');
      await expect(client).rejects.toThrow('Memory drain client deadline');
    } catch (error) {
      failed = true; primaryFailure = error;
    } finally {
      for (const socket of sockets) socket.destroy();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('owned server cleanup deadline')), 1000); }),
        ]);
        cleanupKnown = true;
      } catch (error) { cleanupFailed = true; cleanupFailure = error; }
      finally { if (timer) clearTimeout(timer); }
    }
    if (failed) {
      if (cleanupFailed) reportCleanupFailure(cleanupFailure);
      throw primaryFailure;
    }
    if (cleanupFailed) throw cleanupFailure;
    expect(server.listening).toBe(false);
    expect([...sockets].every(socket => socket.destroyed)).toBe(true);
    }, () => cleanupKnown);
  });

  it('retains owned scratch when fixture settlement is not confirmed', async () => {
    let ownedDirectory = '';
    let cleanupKnown = false;
    let closed: Promise<void> = Promise.resolve();
    let closeConfirmed = false;
    try {
      await expect(owned(async directory => {
        ownedDirectory = directory;
        const operator = await MemoryUpgradeOperator.prepare(directory);
        await operator.listen();
        const server = (operator as unknown as { server: net.Server }).server;
        closed = new Promise<void>(resolve => server.once('close', resolve));
        await cleanupHeldFixture(operator, () => {}, () => {},
          Promise.reject(new Error('fixture original work failed')), () => {});
        cleanupKnown = true;
      }, () => cleanupKnown)).rejects.toThrow('fixture original work failed');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('owned server close observation deadline')), 1000);
        })]);
        closeConfirmed = true;
      } finally { if (timer) clearTimeout(timer); }
      await expect(fs.access(ownedDirectory)).resolves.toBeUndefined();
    } finally {
      if (ownedDirectory && closeConfirmed) await fs.rm(ownedDirectory, { recursive: true, force: true });
      else if (ownedDirectory) process.stderr.write(`Owned fixture retained because close was not confirmed: ${ownedDirectory}\n`);
    }
  });

  it('closes its owned fixture after a real early server refusal', async () => {
    let operator!: MemoryUpgradeOperator;
    let ownedDirectory = '';
    let intentSpy!: ReturnType<typeof jest.spyOn>;
    let cleanupKnown = false;
    await expect(owned(async directory => {
      ownedDirectory = directory;
      operator = await MemoryUpgradeOperator.prepare(directory);
      const lifecycle = new MemoryUpgradeLifecycle();
      let releaseIntent = (): void => {};
      let releaseOriginal = (): void => {};
      let original: Promise<unknown> = Promise.resolve();
      let primaryFailure: unknown;
      let cleanupFailure: unknown;
      let failed = false;
      let cleanupFailed = false;
      try {
        // A bound but unenabled server refuses the actual request before intent.
        operator.bindLifecycle(lifecycle); await operator.listen();
        let enteredIntent!: () => void;
        const intentEntered = new Promise<void>(resolve => { enteredIntent = resolve; });
        const intentHeld = new Promise<void>(resolve => { releaseIntent = resolve; });
        const request = operator.state.request.bind(operator.state);
        intentSpy = jest.spyOn(operator.state, 'request').mockImplementation(async (...args) => {
          enteredIntent(); await intentHeld; return request(...args);
        });
        const originalHeld = new Promise<void>(resolve => { releaseOriginal = resolve; });
        original = lifecycle.runRequest(() => lifecycle.runWrite(() => originalHeld));
        const client = requestMemoryDrain(directory, containerId, nonce, 50);
        const refusal = expect(client).rejects.toThrow();
        void refusal.catch(() => {});
        await waitForIntentOrClient(intentEntered, client);
      } catch (error) {
        failed = true; primaryFailure = error;
      } finally {
        try {
          await cleanupHeldFixture(operator, releaseIntent, releaseOriginal, original, () => intentSpy?.mockRestore());
          cleanupKnown = true;
        } catch (error) { cleanupFailed = true; cleanupFailure = error; }
      }
      if (failed) {
        if (cleanupFailed) reportCleanupFailure(cleanupFailure);
        throw primaryFailure;
      }
      if (cleanupFailed) throw cleanupFailure;
    }, () => cleanupKnown)).rejects.toThrow('fixture client settled before intent entry');
    const internal = operator as unknown as { server?: net.Server; sockets: Set<net.Socket> };
    expect(internal.server?.listening).toBe(false);
    expect([...internal.sockets].every(socket => socket.destroyed)).toBe(true);
    expect(jest.isMockFunction(operator.state.request)).toBe(false);
    await expect(fs.access(ownedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['nonce', 'bootId', 'containerId'])('rejects a JSON array in the %s token without creating intent', field => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); operator.enableOriginalDrain();
    await operator.listen();
    const socket = net.createConnection(operator.socketPath);
    const closed = new Promise<void>((resolve, reject) => {
      socket.once('close', () => resolve()); socket.once('error', reject);
    });
    if (field === 'nonce') socket.write(`${JSON.stringify({ protocol: 2, phase: 'hello', nonce: [nonce] })}\n`);
    else {
      socket.write(`${JSON.stringify({ protocol: 2, phase: 'hello', nonce })}\n`);
      await new Promise<void>(resolve => socket.once('data', () => resolve()));
      socket.write(`${JSON.stringify({ protocol: 2, phase: 'drain', nonce, bootId: operator.bootId,
        containerId, remainingMs: 1000, [field]: [field === 'bootId' ? operator.bootId : containerId] })}\n`);
    }
    await closed;
    expect(await operator.state.read()).toEqual({ kind: 'absent' });
    expect(lifecycle.getSummary().state).toBe('running');
    await lifecycle.quiesceAndDrain(); await operator.closeAfterDrain();
  }));

  it('refuses original drain before a lifecycle root is bound', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    await operator.listen();
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    expect(await operator.state.read()).toEqual({ kind: 'absent' });
    await closeEmptyFixture(operator);
  }));
  it('refuses a bound root until its supported runtime finishes bootstrap', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); await operator.listen();
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    expect(await operator.state.read()).toEqual({kind:'absent'});
    expect(lifecycle.getSummary().state).toBe('running');
    operator.enableOriginalDrain();
    expect((await requestMemoryDrain(directory, containerId, nonce, 1000)).phase).toBe('drained');
    await operator.closeAfterDrain();
  }));

  it('persists an immutable intent and synced drained state without clearing either', () => owned(async directory => {
    const state = new MemoryUpgradeControlState(directory);
    expect(await state.read()).toEqual({ kind: 'absent' });
    const requested = await state.request(containerId, boot);
    expect(await state.read()).toEqual({ kind: 'requested', record: requested });
    const intentBytes = await fs.readFile(path.join(directory, 'intent.json'), 'utf8');
    const drained = await state.markDrained(requested);
    expect(await state.read()).toEqual({ kind: 'drained', record: drained });
    expect(await fs.readFile(path.join(directory, 'intent.json'), 'utf8')).toBe(intentBytes);
    for (const name of ['intent.json', 'state.json']) expect((await fs.stat(path.join(directory, name))).mode & 0o777).toBe(0o600);
    await expect(state.request(containerId, boot)).rejects.toThrow('intent unavailable');
  }));

  it.each(['intent.json', 'state.json'])('refuses a missing %s instead of inventing first-boot absence', missing => owned(async directory => {
    const state = new MemoryUpgradeControlState(directory);
    await state.request(containerId, boot);
    await fs.unlink(path.join(directory, missing));
    expect(await state.read()).toEqual({ kind: 'unknown' });
  }));

  it('preserves partial atomic persistence as unknown and never invokes root drain', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); operator.enableOriginalDrain();
    await operator.listen();
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Owned injected rename refusal'));
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    rename.mockRestore();
    expect(lifecycle.getSummary().state).toBe('quiescing');
    expect(await operator.state.read()).toEqual({ kind: 'unknown' });
    await lifecycle.quiesceAndDrain();
    await operator.closeAfterDrain();
    expect((await MemoryUpgradeOperator.prepare(directory)).controlOnly).toBe(true);
  }));

  it('does not acknowledge an unknown drained-state rename even after original work settles', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); operator.enableOriginalDrain();
    await operator.listen();
    const rename = fs.rename.bind(fs);
    let calls = 0;
    const fault = jest.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Owned drained-state rename refusal');
      return rename(...args);
    });
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    fault.mockRestore();
    expect(lifecycle.getSummary().state).toBe('drained');
    expect(await operator.state.read()).toEqual({ kind: 'unknown' });
    await operator.closeAfterDrain();
    const successor = await MemoryUpgradeOperator.prepare(directory);
    expect(successor.controlOnly).toBe(true);
    await successor.listen();
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    await expect(successor.closeAfterDrain()).rejects.toThrow('refused');
    await closeEmptyFixture(successor);
  }));

  it('refuses a failed intent file sync before any flush and fences the successor', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); operator.enableOriginalDrain(); await operator.listen();
    const stop = jest.fn(); lifecycle.registerStopSource(stop);
    const open = fs.open.bind(fs);
    const fault = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path.join(directory, 'intent.json')) jest.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Owned intent sync refusal'));
      return handle;
    });
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    fault.mockRestore();
    expect(stop).not.toHaveBeenCalled();
    expect(lifecycle.getSummary().state).toBe('quiescing');
    expect(await operator.state.read()).toEqual({kind:'unknown'});
    expect((await MemoryUpgradeOperator.prepare(directory)).controlOnly).toBe(true);
    await lifecycle.quiesceAndDrain(); await operator.closeAfterDrain();
  }));

  it('keeps drained persistence ambiguous after a directory sync failure instead of ACKing visible bytes', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); operator.enableOriginalDrain(); await operator.listen();
    const open = fs.open.bind(fs);
    let directories = 0;
    const fault = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === directory && ++directories === 4) jest.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Owned drained directory sync refusal'));
      return handle;
    });
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    fault.mockRestore();
    expect(lifecycle.getSummary().state).toBe('drained');
    expect(await operator.state.read()).toEqual({kind:'unknown'});
    expect(await fs.readdir(directory)).toContain('drained-pending.json');
    await operator.closeAfterDrain();
  }));

  it('lost client retains the original admitted write and a later exact drain obtains acknowledgement', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); operator.enableOriginalDrain();
    await operator.listen();
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let originalCompletions = 0;
    const original = lifecycle.runRequest(() => lifecycle.runWrite(async () => {
      started(); await held; originalCompletions++;
    }));
    await began;
    let client!: net.Socket;
    const connect = net.createConnection.bind(net);
    const connection = jest.spyOn(net, 'createConnection').mockImplementation((...args: Parameters<typeof net.createConnection>) => {
      client = connect(...args);
      return client;
    });
    lifecycle.registerStopSource(() => client.destroy());
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow();
    connection.mockRestore();
    expect(lifecycle.getSummary()).toMatchObject({ admitted: 1, writes: 1 });
    await expect(lifecycle.runRequest(async () => undefined)).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
    release(); await original;
    const ack = await requestMemoryDrain(directory, containerId, nonce, 1000);
    expect(ack).toMatchObject({ protocol: 2, phase: 'drained', containerId, nonce, bootId: operator.bootId,
      sourceBootId: operator.bootId, mode: 'same-boot', admitted: 0, writes: 0, failedWrites: 0, retainedOwners: 0 });
    expect(originalCompletions).toBe(1);
    expect((await operator.state.read()).kind).toBe('drained');
    await operator.closeAfterDrain();
  }));

  it('a requested successor refuses root binding and empty-accounting completion', () => owned(async directory => {
    await new MemoryUpgradeControlState(directory).request(containerId, boot);
    const successor = await MemoryUpgradeOperator.prepare(directory);
    expect(successor.controlOnly).toBe(true);
    expect(() => successor.bindLifecycle(new MemoryUpgradeLifecycle())).toThrow('root cannot be replaced');
    await successor.listen();
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    await expect(successor.closeAfterDrain()).rejects.toThrow('refused');
    await closeEmptyFixture(successor);
  }));

  it('a drained successor acknowledges inherited known generation but admits no new root', () => owned(async directory => {
    const state = new MemoryUpgradeControlState(directory);
    const requested = await state.request(containerId, boot);
    await state.markDrained(requested);
    const successor = await MemoryUpgradeOperator.prepare(directory);
    expect(successor.controlOnly).toBe(true);
    expect(() => successor.bindLifecycle(new MemoryUpgradeLifecycle())).toThrow('root cannot be replaced');
    await successor.listen();
    const ack = await requestMemoryDrain(directory, containerId, nonce, 1000);
    expect(ack).toMatchObject({ sourceBootId: boot, bootId: successor.bootId, generation: requested.generation, mode: 'drained-successor' });
    await expect(requestMemoryDrain(directory, 'd'.repeat(64), nonce, 1000)).rejects.toThrow('refused');
    await successor.closeAfterDrain();
    expect((await state.read()).kind).toBe('drained');
  }));

  it('refuses an inherited certificate whose original boot identity changes', () => owned(async directory => {
    const state = new MemoryUpgradeControlState(directory);
    const requested = await state.request(containerId, boot);
    const drained = await state.markDrained(requested);
    const successor = await MemoryUpgradeOperator.prepare(directory);
    await successor.listen();
    const changed = {...drained, sourceBootId:'d'.repeat(64)};
    const seal = {protocol:2,containerId,generation:changed.generation,sourceBootId:changed.sourceBootId};
    await fs.writeFile(path.join(directory, 'intent.json'), JSON.stringify(seal));
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(changed));
    await expect(requestMemoryDrain(directory, containerId, nonce, 1000)).rejects.toThrow('refused');
    await expect(successor.closeAfterDrain()).rejects.toThrow('refused');
    await closeEmptyFixture(successor);
  }));

  it('refuses wrong mode and symlink control paths before any root binding', () => owned(async directory => {
    await fs.chmod(directory, 0o755);
    await expect(MemoryUpgradeOperator.prepare(directory)).rejects.toThrow('ownership');
    await fs.chmod(directory, 0o700);
    const alias = `${directory}-alias`;
    await fs.symlink(directory, alias);
    try { await expect(MemoryUpgradeOperator.prepare(alias)).rejects.toThrow('directory'); }
    finally { await fs.unlink(alias); }
  }));
});
