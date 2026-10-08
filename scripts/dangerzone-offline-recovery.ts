#!/usr/bin/env tsx
/** Human operator CLI only. It does not stop services or prove external writer exclusion. */
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DangerZoneOfflineRecovery } from '../src/security/DangerZoneOfflineRecovery.js';

/** Credential never enters argv, echo, logs, confirmation metadata or recovery audit. */
export async function readRecoveryCredential(): Promise<string> {
  if (!stdin.isTTY || !stderr.isTTY) throw new Error('Interactive operator terminal required');
  stderr.write('Configured DangerZone administrator token (hidden): ');
  const previous = stdin.isRaw;
  stdin.setRawMode(true); stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []; let length = 0;
      const cleanup = () => { stdin.off('data', receive); stdin.off('end', ended); stdin.off('error', failed); };
      const failed = () => { cleanup(); reject(new Error('Credential input unavailable')); };
      const ended = () => { cleanup(); reject(new Error('Credential input ended')); };
      const receive = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) { cleanup(); reject(new Error('Operator cancelled')); return; }
          if (byte === 10 || byte === 13) { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); return; }
          if (++length > 65536 || byte < 32 || byte === 127) { failed(); return; }
          chunks.push(Buffer.from([byte]));
        }
      };
      stdin.on('data', receive); stdin.once('end', ended); stdin.once('error', failed);
    });
  } finally { stdin.setRawMode(previous); stdin.pause(); stderr.write('\n'); }
}

export async function runOfflineRecoveryCli(argv: readonly string[]): Promise<void> {
  if (!stdin.isTTY || !stderr.isTTY || typeof process.getuid !== 'function') throw new Error('Interactive POSIX operator terminal required');
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i+1];
    if (!['--security-dir', '--agent', '--quiescence-evidence'].includes(key) || !value || values.has(key)) throw new Error('Exact recovery arguments required');
    values.set(key, value);
  }
  const securityDir = values.get('--security-dir'); const agentName = values.get('--agent');
  const evidencePath = values.get('--quiescence-evidence');
  if (!securityDir || !agentName || !evidencePath) throw new Error('Exact namespace, agent and operational evidence required');
  const operator = userInfo();
  const recovery = new DangerZoneOfflineRecovery({ securityDir, evidencePath, operator,
    configuredAdminToken: process.env.DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN,
    confirm: async proposal => {
      stderr.write(`OFFLINE single-block recovery for operator ${operator.username} (uid ${operator.uid})\n`);
      stderr.write(`Namespace: ${JSON.stringify(proposal.namespace)}\nExact agent: ${JSON.stringify(proposal.agentName)}\nOriginal SHA256: ${proposal.originalSha256}\nBlock SHA256: ${proposal.blockSha256}\nOperational evidence SHA256: ${proposal.evidenceSha256}\n`);
      stderr.write('This CLI has NOT verified shutdown. Proceed only with approved all-writer stop/drain and exclusive volume control.\n');
      stderr.write(`Human confirmation code: ${proposal.code}\n`);
      const terminal = createInterface({ input: stdin, output: stderr });
      try { return await terminal.question('Enter the code to remove ONLY this block (one attempt, expires in five minutes): '); }
      finally { terminal.close(); }
    } });
  const result = await recovery.run(await readRecoveryCredential(), agentName);
  stderr.write(JSON.stringify({ status: result.status, invocationId: result.invocationId,
    auditPath: result.auditPath, backupPath: result.backupPath })+'\n');
  if (result.status !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOfflineRecoveryCli(process.argv.slice(2)).catch(() => {
    stderr.write('Offline recovery did not complete. Preserve evidence and keep writers stopped.\n');
    process.exitCode = 1;
  });
}
