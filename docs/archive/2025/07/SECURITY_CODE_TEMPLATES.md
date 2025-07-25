# Security Code Templates - Ready to Copy

## CommandValidator Template
```typescript
// src/security/commandValidator.ts
import { spawn, SpawnOptions } from 'child_process';
import path from 'path';

const ALLOWED_COMMANDS = {
  git: ['pull', 'status', 'log', 'rev-parse', 'branch', 'checkout'],
  npm: ['install', 'run', 'audit', 'ci', '--version'],
  node: ['--version'],
  npx: ['--version']
};

export class CommandValidator {
  static sanitizeCommand(cmd: string, args: string[]): void {
    if (!ALLOWED_COMMANDS[cmd]) {
      throw new Error(`Command not allowed: ${cmd}`);
    }
    
    const allowedArgs = ALLOWED_COMMANDS[cmd];
    for (const arg of args) {
      // Check if it's in allowed list or matches safe pattern
      if (!allowedArgs.includes(arg) && !this.isSafeArgument(arg)) {
        throw new Error(`Argument not allowed: ${arg}`);
      }
    }
  }

  private static isSafeArgument(arg: string): boolean {
    // Allow alphanumeric, dash, underscore, dot
    return /^[a-zA-Z0-9\-_.]+$/.test(arg);
  }

  static async secureExec(command: string, args: string[], options?: SpawnOptions): Promise<string> {
    this.sanitizeCommand(command, args);
    
    const safeOptions: SpawnOptions = {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/local/bin' // Restrict PATH
      },
      cwd: options?.cwd || process.cwd(),
      timeout: options?.timeout || 30000 // 30 second default
    };
    
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, safeOptions);
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => stdout += data);
      proc.stderr?.on('data', (data) => stderr += data);
      
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed (${code}): ${stderr}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
}
```

## PathValidator Template
```typescript
// src/security/pathValidator.ts
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

export class PathValidator {
  private static readonly ALLOWED_DIRECTORIES = [
    path.resolve('./personas'),
    path.resolve('./custom-personas'),
    path.resolve('./backups'),
    path.resolve(process.env.PERSONAS_DIR || './personas')
  ];

  static async validatePersonaPath(userPath: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    // Remove any null bytes
    const cleanPath = userPath.replace(/\x00/g, '');
    
    // Normalize and resolve path
    const normalizedPath = path.normalize(cleanPath);
    const resolvedPath = path.resolve(normalizedPath);
    
    // Check for path traversal attempts
    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath });
      throw new Error('Path traversal detected');
    }
    
    // Check if path is within allowed directories
    const isAllowed = this.ALLOWED_DIRECTORIES.some(allowedDir => 
      resolvedPath.startsWith(allowedDir + path.sep) || 
      resolvedPath === allowedDir
    );
    
    if (!isAllowed) {
      throw new Error(`Path access denied: ${userPath}`);
    }
    
    // Validate filename if it's a file
    if (path.extname(resolvedPath)) {
      const filename = path.basename(resolvedPath);
      if (!/^[a-zA-Z0-9\-_.]+\.md$/i.test(filename)) {
        throw new Error(`Invalid filename format: ${filename}`);
      }
    }
    
    return resolvedPath;
  }

  static async safeReadFile(filePath: string): Promise<string> {
    const validatedPath = await this.validatePersonaPath(filePath);
    
    // Check file exists and is not a directory
    const stats = await fs.stat(validatedPath);
    if (stats.isDirectory()) {
      throw new Error('Path is a directory, not a file');
    }
    
    // Size check
    if (stats.size > 500000) { // 500KB
      throw new Error('File too large');
    }
    
    return fs.readFile(validatedPath, 'utf-8');
  }

  static async safeWriteFile(filePath: string, content: string): Promise<void> {
    const validatedPath = await this.validatePersonaPath(filePath);
    
    // Content validation
    if (content.length > 500000) {
      throw new Error('Content too large');
    }
    
    // Write to temp file first (atomic write)
    const tempPath = `${validatedPath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    
    // Rename to final path (atomic on most filesystems)
    await fs.rename(tempPath, validatedPath);
  }
}
```

## YamlValidator Template
```typescript
// src/security/yamlValidator.ts
import yaml from 'js-yaml';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

const PersonaMetadataSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  unique_id: z.string().optional(),
  author: z.string().max(50).optional(),
  triggers: z.array(z.string().max(50)).max(20).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  category: z.enum(['creative', 'professional', 'educational', 'gaming', 'personal']).optional(),
  age_rating: z.enum(['all', '13+', '18+']).optional(),
  ai_generated: z.boolean().optional(),
  generation_method: z.string().max(50).optional(),
  price: z.string().max(20).optional(),
  license: z.string().max(100).optional(),
  created_date: z.string().optional()
});

export class YamlValidator {
  static parsePersonaMetadataSafely(yamlContent: string): any {
    if (!yamlContent || typeof yamlContent !== 'string') {
      throw new Error('YAML content must be a non-empty string');
    }
    
    // Size check
    if (yamlContent.length > 50000) { // 50KB
      throw new Error('YAML content too large');
    }
    
    try {
      // Use safe load with restricted schema
      const rawData = yaml.load(yamlContent, {
        schema: yaml.CORE_SCHEMA, // No functions, only basic types
        onWarning: (warning) => {
          logger.warn('YAML parsing warning:', warning);
        }
      });
      
      // Validate against schema
      const validatedData = PersonaMetadataSchema.parse(rawData);
      
      // Additional sanitization
      return this.sanitizeMetadata(validatedData);
    } catch (error) {
      if (error.name === 'YAMLException') {
        throw new Error(`Invalid YAML syntax: ${error.message}`);
      }
      throw new Error(`Invalid persona metadata: ${error.message}`);
    }
  }

  private static sanitizeMetadata(data: any): any {
    const sanitized = { ...data };
    
    // Sanitize string fields
    const stringFields = ['name', 'description', 'author', 'unique_id'];
    for (const field of stringFields) {
      if (sanitized[field]) {
        sanitized[field] = this.sanitizeString(sanitized[field]);
      }
    }
    
    // Sanitize array fields
    if (sanitized.triggers) {
      sanitized.triggers = sanitized.triggers.map(t => this.sanitizeString(t));
    }
    
    return sanitized;
  }

  private static sanitizeString(input: string): string {
    return input
      .replace(/[<>]/g, '') // Remove potential XSS
      .replace(/\x00/g, '') // Remove null bytes
      .replace(/[\r\n]/g, ' ') // Replace newlines with spaces
      .trim();
  }
}
```

## InputValidator Template
```typescript
// src/security/inputValidator.ts
export class InputValidator {
  static validatePersonaName(name: string): string {
    if (!name || typeof name !== 'string') {
      throw new Error('Persona name is required');
    }
    
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      throw new Error('Persona name must be 1-100 characters');
    }
    
    if (!/^[a-zA-Z0-9\s\-_.]+$/.test(trimmed)) {
      throw new Error('Persona name contains invalid characters');
    }
    
    return trimmed;
  }

  static validateUrl(url: string): string {
    if (!url || typeof url !== 'string') {
      throw new Error('URL is required');
    }
    
    try {
      const parsed = new URL(url);
      
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP(S) URLs allowed');
      }
      
      // SSRF protection
      const hostname = parsed.hostname.toLowerCase();
      const privatePatterns = [
        /^localhost$/,
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
        /^192\.168\./,
        /^169\.254\./,
        /^::1$/,
        /^fc00:/,
        /^fe80:/
      ];
      
      if (privatePatterns.some(pattern => pattern.test(hostname))) {
        throw new Error('Private network URLs not allowed');
      }
      
      return url;
    } catch (error) {
      throw new Error(`Invalid URL: ${error.message}`);
    }
  }

  static validateBase64(data: string): string {
    if (!data || typeof data !== 'string') {
      throw new Error('Base64 data is required');
    }
    
    // Remove whitespace
    const cleaned = data.replace(/\s/g, '');
    
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      throw new Error('Invalid base64 format');
    }
    
    if (cleaned.length > 500000) {
      throw new Error('Base64 data too large');
    }
    
    return cleaned;
  }

  static validateCategory(category: string): string {
    const valid = ['creative', 'professional', 'educational', 'gaming', 'personal'];
    
    if (!valid.includes(category)) {
      throw new Error(`Invalid category. Must be one of: ${valid.join(', ')}`);
    }
    
    return category;
  }

  static validateExpiryDays(days: any): number {
    const num = parseInt(days);
    
    if (isNaN(num) || num < 1 || num > 365) {
      throw new Error('Expiry must be 1-365 days');
    }
    
    return num;
  }
}
```

## Usage in MCP Tools
```typescript
// In index.ts tool handlers

async handleCreatePersona(args: any) {
  // Validate all inputs
  const name = InputValidator.validatePersonaName(args.name);
  const category = InputValidator.validateCategory(args.category);
  const description = this.sanitizeString(args.description);
  const content = InputValidator.validatePersonaContent(args.content);
  
  // Safe file path
  const filename = `${name.replace(/\s+/g, '-').toLowerCase()}.md`;
  const filepath = await PathValidator.validatePersonaPath(filename);
  
  // Create with safe YAML
  const metadata = {
    name,
    description,
    category,
    // ... other fields
  };
  
  const yamlStr = yaml.dump(metadata, { schema: yaml.CORE_SCHEMA });
  const fullContent = `---\n${yamlStr}---\n\n${content}`;
  
  // Write with file locking
  await FileLockManager.withLock(`persona:${name}`, async () => {
    await PathValidator.safeWriteFile(filepath, fullContent);
  });
}
```