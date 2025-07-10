/**
 * Debug tools for retrieving server logs
 */

import { logger } from '../utils/logger.js';

export interface GetLogsArgs {
  count?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export async function getServerLogs(args: GetLogsArgs) {
  const { count = 100, level } = args;
  
  const logs = logger.getLogs(count, level);
  
  // Format logs for display
  const formattedLogs = logs.map(log => {
    const timestamp = log.timestamp.toISOString();
    const logLevel = log.level.toUpperCase().padEnd(5);
    const message = log.data 
      ? `${log.message} ${JSON.stringify(log.data, null, 2)}`
      : log.message;
    
    return `[${timestamp}] [${logLevel}] ${message}`;
  }).join('\n');
  
  return {
    content: [
      {
        type: "text",
        text: formattedLogs || "No logs found matching the criteria",
      },
    ],
  };
}

export async function clearServerLogs() {
  logger.clearLogs();
  
  return {
    content: [
      {
        type: "text",
        text: "Server logs cleared successfully",
      },
    ],
  };
}