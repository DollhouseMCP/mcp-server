import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { IDangerZoneBlockStore, BlockMutation } from './IDangerZoneBlockStore.js';
import { readDangerZoneBlockSnapshot } from './readDangerZoneBlockSnapshot.js';

/**
 * Single-process store with whole-snapshot writes and in-memory refresh reads.
 * It is not shared across processes. Evidence copies named <file>.<uuid>.backup
 * are retained and never pruned automatically.
 */
export class FileDangerZoneBlockStore implements IDangerZoneBlockStore {
  readonly location: string;
  private liveSnapshot: Record<string, unknown> | undefined;
  constructor(private readonly fileOps: FileOperationsService, directory = path.join(os.homedir(), '.dollhouse', 'security')) {
    this.location = path.join(directory, 'blocked-agents.json');
  }

  async load(refresh = false) {
    if (refresh && this.liveSnapshot) return { status: 'loaded' as const, value: this.liveSnapshot };
    const result = await readDangerZoneBlockSnapshot(
      () => this.fileOps.readFile(this.location),
      typeof this.fileOps.stat === 'function' ? () => this.fileOps.stat(this.location) : undefined,
    );
    if (result.status === 'loaded') this.liveSnapshot = result.value;
    if (result.status === 'absent') this.liveSnapshot = {};
    return result;
  }

  async save(blocks: Record<string, unknown>): Promise<void> {
    await this.fileOps.createDirectory(path.dirname(this.location), 0o700);
    await this.fileOps.writeFile(this.location, JSON.stringify({ version: 1, blocks }, null, 2));
    this.liveSnapshot = blocks;
  }

  async apply(_mutation: BlockMutation, snapshot: Record<string, unknown>): Promise<boolean> {
    // The mutation is unused because file persistence writes the whole snapshot.
    await this.save(snapshot);
    return true;
  }

  async reset(): Promise<string> {
    await this.fileOps.createDirectory(path.dirname(this.location), 0o700);
    let evidence = `${this.location}.${randomUUID()}.backup`;
    try {
      await this.fileOps.copyFile(this.location, evidence, { exclusive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      evidence = '';
    }
    if (evidence) await this.fileOps.chmod(evidence, 0o600);
    await this.save({});
    return evidence;
  }
}
