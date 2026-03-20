import type { ILogFormatter, UnifiedLogEntry } from '../types.js';

export class PlainTextFormatter implements ILogFormatter {
  readonly fileExtension = '.log';

  format(entry: UnifiedLogEntry): string {
    const ts = entry.timestamp.replace('T', ' ').replace('Z', '');
    const level = entry.level.toUpperCase();
    const corrId = entry.correlationId ? ` [${entry.correlationId}]` : '';
    let output = `[${ts}] [${level}] [${entry.source}]${corrId} ${entry.message}\n`;

    if (entry.error) {
      output += `  ${entry.error.name}: ${entry.error.message}\n`;
      if (entry.error.stack) {
        for (const line of entry.error.stack.split('\n')) {
          output += `  ${line}\n`;
        }
      }
    }

    if (entry.data) {
      for (const [key, value] of Object.entries(entry.data)) {
        const formatted = typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : String(value);
        output += `  ${key}: ${formatted}\n`;
      }
    }

    output += '\n';
    return output;
  }
}
