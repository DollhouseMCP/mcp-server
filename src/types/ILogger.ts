/**
 * Logger interface for type safety and testing
 *
 * This interface provides type safety for the logger throughout the codebase
 * while maintaining the singleton pattern for simplicity.
 */

export interface LogEntry {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: any;
}

export interface ILogger {
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
  getLogs(count?: number, level?: LogEntry['level']): LogEntry[];
  clearLogs(): void;
  setMCPConnected(): void;
}
