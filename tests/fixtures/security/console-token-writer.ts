import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { withRecoverableFileWriteLock } from '../../../src/utils/RecoverableFileWriteLock.js';
import { ConsoleTokenStore } from '../../../src/web/console/consoleToken.js';

const [operation, tokenFile] = process.argv.slice(2);
if (operation === 'abandon-lock') {
  await withRecoverableFileWriteLock(`${tokenFile}.lock`, () => process.exit(0));
} else {
  const store = new ConsoleTokenStore(tokenFile);
  await store.ensureInitialized('Fixture');
  await writeFile(join(homedir(), 'ready'), '');
  const result = await store.verifyTotp(await text(process.stdin));
  process.stdout.write(JSON.stringify({ ok: result.ok }));
}
