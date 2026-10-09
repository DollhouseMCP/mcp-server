/** Operator-only offline recovery. External writer exclusion is a prerequisite, not inferred here. */
import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { VerificationStore, generateDisplayCode } from '@dollhousemcp/safety';
import { prepareDangerZoneBlockClear, revalidateDangerZoneBlockClear } from './DangerZoneBlockClear.js';

const LIMIT = 10 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
class RecoveryRefusal extends Error {}
function refuse(): never { throw new RecoveryRefusal('Offline recovery prerequisites are unavailable or changed'); }
interface RecoveryProgress { renameStarted: boolean; replaced: boolean; verified: boolean }
interface CapturedFile { readonly bytes: Buffer; readonly identity: Stats; readonly filename: string }
export interface OfflineRecoveryConfirmation {
  readonly namespace: string; readonly agentName: string; readonly originalSha256: string;
  readonly blockSha256: string; readonly evidenceSha256: string; readonly code: string;
}
export interface OfflineRecoveryResult {
  readonly status: 'completed' | 'refused' | 'failed' | 'replacement-unknown' | 'committed-audit-incomplete';
  readonly invocationId: string; readonly auditPath: string; readonly backupPath?: string; readonly cause?: unknown;
}
export interface DangerZoneOfflineRecoveryOptions {
  readonly securityDir: string;
  readonly evidencePath: string;
  readonly operator: { readonly uid: number; readonly username: string };
  readonly configuredAdminToken: string | undefined;
  /** Trusted operator terminal adapter; no MCP/request completion flag. */
  readonly confirm: (proposal: OfflineRecoveryConfirmation) => Promise<string>;
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && (a.isDirectory() && b.isDirectory() || a.nlink === b.nlink);
}

export class DangerZoneOfflineRecovery {
  private readonly challenges = new VerificationStore(0);
  private readonly io: typeof fs;
  constructor(private readonly options: DangerZoneOfflineRecoveryOptions, io: typeof fs = fs) { this.io = io; }

  private requireOwner(stat: Stats): void {
    if (stat.uid !== this.options.operator.uid && this.options.operator.uid !== 0) refuse();
    if ((stat.mode & 0o022) !== 0) refuse();
  }
  private async directory(filename: string): Promise<Stats> {
    if (await this.io.realpath(filename) !== path.resolve(filename)) refuse();
    const stat = await this.io.lstat(filename); this.requireOwner(stat);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
    return stat;
  }
  private async read(filename: string, maximum = LIMIT): Promise<CapturedFile> {
    if (await this.io.realpath(filename) !== path.resolve(filename)) refuse();
    const named = await this.io.lstat(filename); this.requireOwner(named);
    if (!named.isFile() || named.nlink !== 1 || named.isSymbolicLink() || named.size > maximum) refuse();
    const handle = await this.io.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let failure: { cause: unknown } | undefined;
    let captured: CapturedFile | undefined;
    try {
      const opened = await handle.stat(); this.requireOwner(opened);
      if (!sameIdentity(named, opened)) refuse();
      // One extra byte detects growth beyond the bounded snapshot.
      const storage = Buffer.alloc(maximum + 1);
      let offset = 0;
      while (offset < storage.length) {
        const { bytesRead } = await handle.read(storage, offset, storage.length-offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const bytes = storage.subarray(0, offset);
      if (bytes.length > maximum || !sameIdentity(opened, await handle.stat()) ||
        !sameIdentity(opened, await this.io.lstat(filename))) refuse();
      captured = { bytes, identity: opened, filename };
    } catch (cause) { failure = { cause }; }
    await this.close(handle, failure);
    if (!captured) refuse();
    return captured;
  }
  private async close(handle: Awaited<ReturnType<typeof fs.open>>, failure?: { cause: unknown }): Promise<void> {
    try { await handle.close(); }
    catch (cause) {
      if (failure) throw new AggregateError([failure.cause, cause], 'Recovery I/O and close failed');
      throw cause;
    }
    if (failure) throw failure.cause;
  }
  private async unchanged(file: CapturedFile): Promise<void> {
    const current = await this.read(file.filename);
    if (!sameIdentity(file.identity, current.identity) || !file.bytes.equals(current.bytes)) refuse();
  }
  // Preserve a BOM as a code point so JSON refuses it rather than silently
  // discarding bytes from the whole-file digest displayed for approval.
  private text(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  private async syncDirectory(filename: string): Promise<void> {
    const identity = await this.directory(filename);
    const handle = await this.io.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let failure: { cause: unknown } | undefined;
    try {
      if (!sameIdentity(identity, await handle.stat())) refuse();
      await handle.sync();
    } catch (cause) { failure = { cause }; }
    await this.close(handle, failure);
  }
  private async writeExclusive(filename: string, bytes: Buffer): Promise<void> {
    const handle = await this.io.open(filename, 'wx', 0o600);
    let failure: { cause: unknown } | undefined;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (bytesWritten <= 0) refuse();
        offset += bytesWritten;
      }
      await handle.sync();
    } catch (cause) { failure = { cause }; }
    await this.close(handle, failure);
  }
  private async evidence(namespace: string): Promise<CapturedFile> {
    const file = await this.read(path.resolve(this.options.evidencePath), 64 * 1024);
    if ((file.identity.mode & 0o077) !== 0) refuse();
    const value: unknown = JSON.parse(this.text(file.bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
    const record = value as Record<string, unknown>;
    // These are reviewed operator observations, NOT machine proof of shutdown.
    if (record.namespace !== namespace || !Array.isArray(record.writers) || !record.writers.length ||
      record.writers.length > 100 || record.writers.some(writer => !writer || typeof writer !== 'object' ||
        typeof writer.identity !== 'string' || !writer.identity || typeof writer.stopDrainEvidence !== 'string' || !writer.stopDrainEvidence) ||
      typeof record.exclusiveControlEvidence !== 'string' || !record.exclusiveControlEvidence) refuse();
    return file;
  }

  private authorized(provided: string): boolean {
    const expected = this.options.configuredAdminToken;
    return Boolean(expected && provided && timingSafeEqual(Buffer.from(digest(expected), 'hex'), Buffer.from(digest(provided), 'hex')));
  }
  private failureStatus(progress: RecoveryProgress, refused = false): OfflineRecoveryResult['status'] {
    if (progress.verified) return 'committed-audit-incomplete';
    if (progress.renameStarted) return 'replacement-unknown';
    if (refused) return 'refused';
    return 'failed';
  }
  private failureRecord(progress: RecoveryProgress): string {
    if (progress.replaced) return 'replacement-observed-audit-incomplete';
    if (progress.renameStarted) return 'replacement-unknown';
    return 'failed-or-refused';
  }
  private async finishAudit(audit: Awaited<ReturnType<typeof fs.open>>, result: OfflineRecoveryResult,
    progress: RecoveryProgress): Promise<OfflineRecoveryResult> {
    try { await audit.close(); return result; }
    catch (cause) {
      return { ...result, status: this.failureStatus(progress),
        cause: Object.hasOwn(result, 'cause') ? new AggregateError([result.cause, cause], 'Recovery outcome and audit close failed') : cause };
    }
  }
  async run(providedAdminToken: string, agentName: string): Promise<OfflineRecoveryResult> {
    const namespace = path.resolve(this.options.securityDir);
    const parent = await this.directory(namespace);
    const invocationId = randomUUID();
    const artifacts = path.join(namespace, `offline-recovery-${invocationId}`);
    await this.io.mkdir(artifacts, { mode: 0o700 });
    const artifactsIdentity = await this.directory(artifacts);
    const auditPath = path.join(artifacts, 'audit.jsonl');
    const audit = await this.io.open(auditPath, 'wx', 0o600);
    let backupPath: string | undefined;
    const progress: RecoveryProgress = { renameStarted: false, replaced: false, verified: false };
    let binding: Record<string, unknown> = { operatorUid: this.options.operator.uid,
      operatorSha256: digest(this.options.operator.username), namespaceSha256: digest(namespace), agentSha256: digest(agentName) };
    // Binding is enriched after capture; later records include the approved digests.
    const record = async (outcome: string) => {
      if (!sameIdentity(artifactsIdentity, await this.directory(artifacts))) refuse();
      const named = await this.io.lstat(auditPath);
      if (!sameIdentity(named, await audit.stat()) || !named.isFile() || named.nlink !== 1) refuse();
      this.requireOwner(named);
      const bytes = Buffer.from(JSON.stringify({ version: 1, invocationId, occurredAt: new Date().toISOString(), outcome, ...binding })+'\n');
      let offset = 0;
      while (offset < bytes.length) {
        // null advances this descriptor's cursor; iterations depend on bytesWritten.
        const { bytesWritten } = await audit.write(bytes, offset, bytes.length-offset, null);
        if (bytesWritten <= 0) refuse();
        offset += bytesWritten;
      }
      await audit.sync(); await this.syncDirectory(artifacts);
    };
    try {
      await record('requested');
      // Persist the new artifact directory's name in its parent before mutation.
      await this.syncDirectory(namespace);
      if (!this.authorized(providedAdminToken)) {
        await record('denied'); return await this.finishAudit(audit, { status: 'refused', invocationId, auditPath }, progress);
      }
      const evidence = await this.evidence(namespace);
      const original = await this.read(path.join(namespace, 'blocked-agents.json'));
      // Replacement is created by this operator as 0600. Root read authority
      // does not permit changing the service-owned target's effective owner.
      if (original.identity.uid !== this.options.operator.uid) refuse();
      const proposal = prepareDangerZoneBlockClear(this.text(original.bytes), agentName);
      binding = { ...binding, originalSha256: proposal.originalSha256, blockSha256: proposal.blockSha256,
        evidenceSha256: digest(evidence.bytes) };
      const challengeId = randomUUID(); const code = generateDisplayCode();
      this.challenges.set(challengeId, { code, expiresAt: Date.now()+5*60*1000, reason: digest(JSON.stringify(binding)) });
      const entered = await this.options.confirm({ namespace, agentName, originalSha256: proposal.originalSha256,
        blockSha256: proposal.blockSha256, evidenceSha256: digest(evidence.bytes), code });
      if (!this.challenges.verify(challengeId, entered)) refuse();
      await this.unchanged(evidence); await this.unchanged(original);
      if (!sameIdentity(parent, await this.directory(namespace))) refuse();
      backupPath = path.join(artifacts, 'original.json');
      await this.writeExclusive(backupPath, original.bytes);
      const backup = await this.read(backupPath);
      if (!backup.bytes.equals(original.bytes)) refuse();
      await this.syncDirectory(artifacts); await record('approved');
      const replacement = Buffer.from(proposal.replacement, 'utf8');
      const temp = path.join(namespace, `.blocked-agents-recovery-${invocationId}.tmp`);
      await this.writeExclusive(temp, replacement);
      const staged = await this.read(temp);
      if (!staged.bytes.equals(replacement)) refuse();
      await this.unchanged(evidence); await this.unchanged(backup); await this.unchanged(staged);
      await this.unchanged(original);
      revalidateDangerZoneBlockClear(this.text(original.bytes), proposal);
      if (!sameIdentity(parent, await this.directory(namespace))) refuse();
      await record('replacement-prepared');
      // External exclusive operational authority covers the final compare/rename gap.
      await this.unchanged(original); await this.unchanged(evidence); await this.unchanged(backup); await this.unchanged(staged);
      if (!sameIdentity(parent, await this.directory(namespace))) refuse();
      progress.renameStarted = true;
      await this.io.rename(temp, original.filename); progress.replaced = true;
      const result = await this.read(original.filename);
      if (!sameIdentity(staged.identity, result.identity) || !result.bytes.equals(replacement)) refuse();
      progress.verified = true;
      await this.syncDirectory(namespace);
      await record('completed');
      return await this.finishAudit(audit, { status: 'completed', invocationId, auditPath, backupPath }, progress);
    } catch (cause) {
      const status = this.failureStatus(progress, cause instanceof RecoveryRefusal);
      try { await record(this.failureRecord(progress)); }
      catch { /* Preserve original cause; no claim that a failed audit was delivered. */ }
      return await this.finishAudit(audit, { status, invocationId, auditPath, backupPath, cause }, progress);
    } finally {
      this.challenges.clear();
    }
  }
}
