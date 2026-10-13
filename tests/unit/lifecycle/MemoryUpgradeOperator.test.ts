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

async function owned(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-control-unit-')));
  await fs.chmod(directory, 0o700);
  try { await body(directory); }
  finally { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); }
}

async function closeEmptyFixture(operator: MemoryUpgradeOperator): Promise<void> {
  // Only disposable library listeners with no actual root/owners. Never used by the product.
  const server = (operator as unknown as { server: net.Server }).server;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

unix('Private memory admission control', () => {
  it('closes admission before held intent I/O and refuses an expired request without flushing original work', () => owned(async directory => {
    const operator = await MemoryUpgradeOperator.prepare(directory);
    const lifecycle = new MemoryUpgradeLifecycle();
    operator.bindLifecycle(lifecycle); operator.enableOriginalDrain();
    await operator.listen();
    let releaseIntent!: () => void;
    let enteredIntent!: () => void;
    const intentEntered = new Promise<void>(resolve => { enteredIntent = resolve; });
    const intentHeld = new Promise<void>(resolve => { releaseIntent = resolve; });
    const request = operator.state.request.bind(operator.state);
    const intent = jest.spyOn(operator.state, 'request').mockImplementation(async (...args) => {
      enteredIntent(); await intentHeld; return request(...args);
    });
    let releaseOriginal!: () => void;
    const originalHeld = new Promise<void>(resolve => { releaseOriginal = resolve; });
    const original = lifecycle.runRequest(() => lifecycle.runWrite(() => originalHeld));
    const stopped = jest.fn();
    lifecycle.registerStopSource(stopped);
    const client = requestMemoryDrain(directory, containerId, nonce, 50);
    const refusal = expect(client).rejects.toThrow();
    await intentEntered;
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
  }));

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
