import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyImageScan(result, expectedImageId, now = Date.now()) {
  const descriptor = result?.descriptor;
  const database = descriptor?.db?.status;
  const built = Date.parse(database?.built);
  if (descriptor?.name !== 'grype' || descriptor.version !== '0.121.0' ||
      database?.valid !== true || !Number.isFinite(built) || built > now ||
      now - built > 120 * 60 * 60 * 1000) {
    throw new Error('Image scan unavailable: expected scanner and fresh valid database required');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedImageId ?? '') ||
      result?.source?.type !== 'image' || result.source.target?.imageID !== expectedImageId) {
    throw new Error('Image scan does not identify the exact image built by this job');
  }
  if (!Array.isArray(result.matches) ||
      result.matches.some(match => !match?.vulnerability?.id ||
        typeof match.vulnerability.severity !== 'string' || !match?.artifact?.name)) {
    throw new Error('Image scan findings are missing or malformed');
  }
  const counts = {};
  for (const { vulnerability } of result.matches) {
    counts[vulnerability.severity] = (counts[vulnerability.severity] ?? 0) + 1;
  }
  // Lower and unknown severities remain visible in the complete uploaded JSON.
  console.log(JSON.stringify({ imageId: expectedImageId, database, findings: result.matches.length, counts }));
  if (counts.Critical || counts.High) {
    throw new Error('Application image has unresolved high or critical vulnerability matches');
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyImageScan(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
