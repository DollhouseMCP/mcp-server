import type { ILogFormatter, UnifiedLogEntry } from '../types.js';

export class JsonlFormatter implements ILogFormatter {
  readonly fileExtension = '.jsonl';

  format(entry: UnifiedLogEntry): string {
    const obj: Record<string, unknown> = {
      id: entry.id,
      ts: entry.timestamp,
      level: entry.level,
      cat: entry.category,
      src: entry.source,
      msg: entry.message,
    };

    if (entry.data !== undefined) {
      obj.data = entry.data;
    }
    if (entry.error !== undefined) {
      obj.error = entry.error;
    }
    if (entry.correlationId !== undefined) {
      obj.correlationId = entry.correlationId;
    }
    if (entry.userId !== undefined) {
      obj.userId = entry.userId;
    }
    if (entry.sessionId !== undefined) {
      obj.sessionId = entry.sessionId;
    }

    return JSON.stringify(obj) + '\n';
  }
}
