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
  
  // List of sensitive field patterns to redact (case-insensitive matching)
  private static readonly SENSITIVE_PATTERNS = [
    'password', 'token', 'secret', 'key', 'apikey', 'api_key',
    'authorization', 'auth', 'credential', 'private', 'oauth',
    'access_token', 'refresh_token', 'client_secret', 'bearer',
    'client_id', 'session', 'cookie'
  ];

  /**
   * Check if a field name contains sensitive patterns
   * @param fieldName - The field name to check
   * @returns true if the field name matches sensitive patterns
   */
  private isSensitiveField(fieldName: string): boolean {
    const lowerFieldName = fieldName.toLowerCase();
    return MCPLogger.SENSITIVE_PATTERNS.some(pattern => 
      lowerFieldName.includes(pattern)
    );
  }

  /**
   * Safely assign a value, ensuring sensitive data is never exposed
   * This function makes it explicit to CodeQL that sensitive values are replaced
   * @param key - The object key
   * @param value - The value to potentially sanitize
   * @returns Safe value that can be logged
   */
  private safeAssign(key: string, value: any): any {
    // Explicitly check if this is a sensitive field BEFORE any assignment
    if (this.isSensitiveField(key)) {
      // Return a constant redacted string - no sensitive data flows through
      return '[REDACTED]';
    }
    
    // For non-sensitive fields, recursively sanitize if needed
    if (typeof value === 'object' && value !== null) {
      return this.sanitizeObject(value);
    }
    
    // Primitive non-sensitive values are safe to return
    return value;
  }

  /**
   * Sanitize an object or array recursively
   * @param obj - Object or array to sanitize
   * @returns Sanitized copy with sensitive fields redacted
   */
  private sanitizeObject(obj: any): any {
    // Handle null/undefined
    if (obj == null) return obj;
    
    // Handle non-objects (primitives)
    if (typeof obj !== 'object') return obj;
    
    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map(item => {
        if (typeof item === 'object' && item !== null) {
          return this.sanitizeObject(item);
        }
        return item;
      });
    }
    
    // Handle objects - use safe assignment for each field
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Use safe assignment which checks sensitivity and returns safe values
      sanitized[key] = this.safeAssign(key, value);
    }
    
    return sanitized;
  }

  /**
   * Sanitize sensitive data before logging
   * Security fix: Prevents exposure of OAuth tokens, API keys, passwords, etc.
   * @param data - Data to sanitize (can be any type)
   * @returns Sanitized copy with sensitive fields replaced with '[REDACTED]'
   */
  private sanitizeData(data: any): any {
    // Fast path for null/undefined
    if (data == null) return data;
    
    // Fast path for primitives
    if (typeof data !== 'object') return data;
    
    // Sanitize objects and arrays
    return this.sanitizeObject(data);
  }
  
  /**
   * Internal logging method
   */
  private log(level: LogEntry['level'], message: string, data?: any): void {
    // Sanitize data before storing to prevent sensitive info in memory
    const sanitizedData = this.sanitizeData(data);
    
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      data: sanitizedData
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
        // Security fix: Never log data objects to console to prevent sensitive information disclosure
        // Only log the message itself, data is available in memory logs if needed for debugging
        const safeMessage = `${prefix} ${message}`;
        
        // During initialization, we can use console
        if (level === 'error') {
          console.error(safeMessage);
        } else if (level === 'warn') {
          console.warn(safeMessage);
        } else {
          // For MCP, even during init, avoid stdout for info/debug
          console.error(safeMessage);
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