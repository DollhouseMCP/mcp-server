import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { withRecoverableFileWriteLock } from '../../../src/utils/RecoverableFileWriteLock.js';
import {
  ConsoleTokenStore, type DialogApprovalRequest, type DialogApprovalResult,
} from '../../../src/web/console/consoleToken.js';

const [operation, tokenFile] = process.argv.slice(2);
if (operation === 'abandon-lock') {
  await withRecoverableFileWriteLock(`${tokenFile}.lock`, () => process.exit(0));
} else if (operation === 'bootstrap-stdio') {
  const store = new ConsoleTokenStore(tokenFile);
  await writeFile(join(homedir(), 'ready'), '');
  await text(process.stdin);
  const entry = await store.ensureInitialized('Fixture', { onlyIfBothAbsent: true });
  process.stdout.write(JSON.stringify({ created: entry !== undefined }));
} else if (operation === 'dialog-approval') {
  const store = new ConsoleTokenStore(tokenFile);
  await writeFile(join(homedir(), 'ready'), '');
  const { requests, code } = JSON.parse(await text(process.stdin)) as { requests: DialogApprovalRequest[]; code: string };
  const results: DialogApprovalResult[] = [];
  await requests.reduce<Promise<void>>(async (previous, request) => {
    await previous;
    results.push(await store.confirmApprovalFromDialog(request, async () => ({ confirmed: true, code })));
  }, Promise.resolve());
  process.stdout.write(JSON.stringify(results));
} else {
  const store = new ConsoleTokenStore(tokenFile);
  await store.ensureInitialized('Fixture');
  await writeFile(join(homedir(), 'ready'), '');
  const result = await store.verifyTotp(await text(process.stdin));
  process.stdout.write(JSON.stringify({ ok: result.ok }));
}
