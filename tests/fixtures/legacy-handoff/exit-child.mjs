import { writeSync } from 'node:fs';
import { fixture, append, signalFromArchivedFragments } from './harness.mjs';
const f = fixture();
const response = await append(f);
const signal = signalFromArchivedFragments(f, process, () => {
  writeSync(1, JSON.stringify({ receipt: response.id, pending: f.handler.pendingSaves.size,
    started: f.saveStarted, events: f.events, warnings: f.warnings }) + '\n');
});
signal('SIGTERM');
