/**
 * MCP-safe logger that avoids writing to stdout/stderr during protocol communication
 * 
 * In MCP servers, stdout and stderr are reserved for JSON-RPC protocol messages.
 * Any non-protocol output will cause "Unexpected token" errors in the MCP client.
 * 
 * This logger:
 * - Writes to stderr ONLY during server initialization (before MCP connection)
 * - Stores all logs in memory during runtime
 * - Provides methods to retrieve logs via MCP tools if needed
 */

interface LogEntry {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: any;
}

class MCPLogger {
  private logs: LogEntry[] = [];
  private maxLogs = 1000;
  private isMCPConnected = false;
  
  /**
   * Call this after MCP connection is established to stop console output
   */
  public setMCPConnected(): void {
    this.isMCPConnected = true;
  }
  
  /**
   * Internal logging method
   */
  private log(level: LogEntry['level'], message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      data
    };
    
    // Store in memory
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    
    // Only write to console during initialization
    if (!this.isMCPConnected) {
      // Check NODE_ENV inside the method to ensure it's evaluated at runtime
      const isTest = process.env.NODE_ENV === 'test';
      if (!isTest) {
        const prefix = `[${entry.timestamp.toISOString()}] [${level.toUpperCase()}]`;
        const fullMessage = data 
          ? `${prefix} ${message} ${JSON.stringify(data)}`
          : `${prefix} ${message}`;
        
        // During initialization, we can use console
        if (level === 'error') {
          console.error(fullMessage);
        } else if (level === 'warn') {
          console.warn(fullMessage);
        } else {
          // For MCP, even during init, avoid stdout for info/debug
          console.error(fullMessage);
        }
      }
    }
  }
  
  public debug(message: string, data?: any): void {
    this.log('debug', message, data);
  }
  
  public info(message: string, data?: any): void {
    this.log('info', message, data);
  }
  
  public warn(message: string, data?: any): void {
    this.log('warn', message, data);
  }
  
  public error(message: string, data?: any): void {
    this.log('error', message, data);
  }
  
  /**
   * Get recent logs (for MCP tools to retrieve)
   */
  public getLogs(count = 100, level?: LogEntry['level']): LogEntry[] {
    let filtered = this.logs;
    if (level) {
      filtered = this.logs.filter(log => log.level === level);
    }
    return filtered.slice(-count);
  }
  
  /**
   * Clear logs
   */
  public clearLogs(): void {
    this.logs = [];
  }
}

// Singleton instance
export const logger = new MCPLogger();