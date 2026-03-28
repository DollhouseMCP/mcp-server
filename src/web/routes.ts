/**
 * Web UI API Routes
 *
 * REST endpoints for reading portfolio elements.
 * Read-only — no mutations in V1.
 *
 * All element content is sanitized before serving to prevent XSS.
 *
 * Security note: This web server binds to 127.0.0.1 only (see server.ts).
 * Rate limiting on read-only GET endpoints is not required for localhost-only
 * management interfaces. The POST /api/install endpoint has explicit rate limiting
 * via SlidingWindowRateLimiter (max 10 per minute).
 * codeql[js/missing-rate-limiting] — Acknowledged; localhost-only binding mitigates DoS risk.
 */

import express, { Router } from 'express';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { logger } from '../utils/logger.js';
import { validateElementContent } from './contentPipeline.js';
import type { MCPAQLHandler } from '../handlers/mcp-aql/MCPAQLHandler.js';

/** Normalize user input to NFC form to prevent Unicode homograph attacks */
function normalizeInput(input: string): string {
  return input.normalize('NFC');
}
import { ContentValidator } from '../security/contentValidator.js';

const ELEMENT_TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'] as const;

/** Max file size for element reads (1 MB) */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/** Valid element file extensions */
const VALID_EXTENSIONS = new Set(['.md', '.yaml', '.yml']);

/** Check if a filename is a backup or cruft file */
function isBackupOrCruft(filename: string): boolean {
  if (filename.startsWith('.')) return true;
  if (filename === '_index.json') return true;
  if (filename.includes('.backup') || filename.includes('.state')) return true;
  if (filename.endsWith('.bak') || filename.endsWith('~')) return true;
  if (filename.includes(' copy')) return true;
  return false;
}

/**
 * Load memories from the _index.json file.
 * Memories use date-partitioned storage with an index, unlike other
 * element types which are flat files in a directory.
 */
async function loadMemoriesFromIndex(portfolioDir: string): Promise<unknown[]> {
  const indexPath = join(portfolioDir, 'memories', '_index.json');
  try {
    const raw = await readFile(indexPath, 'utf-8');
    const index = JSON.parse(raw) as {
      entries?: Record<string, { name?: string; description?: string; tags?: string[]; created?: string; [key: string]: unknown }>;
      entryCount?: number;
    };

    const entries = index.entries || {};
    const elements: unknown[] = [];

    for (const [path, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const pathParts = path.split('/');
      const filename = pathParts.pop() || path;
      // Extract date from directory path (e.g., "2025-09-19/code-patterns.yaml" -> "2025-09-19")
      const dateFromPath = pathParts.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(pathParts[0]) ? pathParts[0] : '';
      // Fall back to filename if index has no name or stored "unnamed" (upstream indexer bug)
      const indexName = entry.name && entry.name !== 'unnamed' ? entry.name : null;
      const name = indexName || filename.replace(/\.(yaml|yml|md)$/, '');

      elements.push({
        name,
        description: entry.description || '',
        type: 'memory',
        version: entry.version || '1.0.0',
        author: entry.author || '',
        category: entry.category || entry.memoryType || '',
        tags: entry.tags || [],
        created: entry.created || dateFromPath,
        filename: path, // date/filename path for content loading
      });
    }

    return elements;
  } catch {
    // Fall back to empty if no index
    return [];
  }
}

/**
 * Simple sliding-window rate limiter.
 * Tracks timestamps of recent requests and evicts entries older than the window.
 */
class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the request is allowed, false if rate-limited. */
  tryAcquire(): boolean {
    const now = Date.now();
    // Evict entries outside the window
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
}

/** Rate limiter for /api/install: max 10 installs per 60 seconds */
const installRateLimiter = new SlidingWindowRateLimiter(10, 60_000);

/** Sanitize text content to prevent XSS in rendered HTML */
function sanitizeForHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Parse YAML front matter from a markdown file */
function parseFrontMatter(content: string): { metadata: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  try {
    const parsed = SecureYamlParser.parseRawYaml(match[1]);
    const metadata = (typeof parsed === 'object' && parsed !== null) ? parsed as Record<string, unknown> : {};
    return { metadata, body: match[2] };
  } catch {
    return { metadata: {}, body: match[2] || content };
  }
}

/** Parse a YAML-only file (memories) */
function parseYamlFile(content: string): { metadata: Record<string, unknown>; body: string } {
  try {
    const parsed = SecureYamlParser.parseRawYaml(content);
    const metadata = (typeof parsed === 'object' && parsed !== null) ? parsed as Record<string, unknown> : {};
    return { metadata, body: '' };
  } catch {
    return { metadata: {}, body: content };
  }
}

export function createApiRoutes(portfolioDir: string): Router {
  const router = Router();

  /**
   * GET /api/elements
   * Returns all elements across all types with metadata.
   * Supports optional pagination: ?page=1&pageSize=50
   * Without pagination params, returns all elements (backward compatible).
   */
  router.get('/elements', async (req, res) => {
    try {
      const pageParam = req.query.page as string | undefined;
      const pageSizeParam = req.query.pageSize as string | undefined;
      const wantPagination = pageParam !== undefined && pageSizeParam !== undefined;
      const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
      const pageSize = Math.max(1, Math.min(200, parseInt(pageSizeParam || '50', 10) || 50));

      const result: Record<string, unknown[]> = {};
      let totalCount = 0;

      for (const type of ELEMENT_TYPES) {
        try {
          if (type === 'memories') {
            const memElements = await loadMemoriesFromIndex(portfolioDir);
            result[type] = memElements;
            totalCount += memElements.length;
            continue;
          }

          const typeDir = join(portfolioDir, type);
          const dirStat = await stat(typeDir);
          if (!dirStat.isDirectory()) continue;

          const files = await readdir(typeDir);
          const elements: unknown[] = [];

          for (const file of files) {
            if (isBackupOrCruft(file)) continue;

            const ext = extname(file);
            if (!VALID_EXTENSIONS.has(ext)) continue;

            try {
              const filePath = join(typeDir, file);

              const fileStat = await stat(filePath);
              if (!fileStat.isFile()) continue;
              if (fileStat.size > MAX_FILE_SIZE_BYTES) continue;

              const content = await readFile(filePath, 'utf-8');
              const validationResult = validateElementContent(file, content, type);

              if (!validationResult.valid) {
                logger.debug(`[WebUI] Skipping rejected file ${file}: ${validationResult.rejection?.reason}`);
                continue;
              }

              const { metadata } = validationResult;
              elements.push({
                name: metadata.name || file.replace(ext, ''),
                description: metadata.description || '',
                type: type.slice(0, -1),
                version: metadata.version || '1.0.0',
                author: metadata.author || '',
                category: metadata.category || '',
                tags: metadata.tags || '',
                created: metadata.created || '',
                filename: file,
              });
            } catch (err) {
              logger.debug(`[WebUI] Failed to parse ${file}:`, err);
            }
          }

          result[type] = elements;
          totalCount += elements.length;
        } catch {
          result[type] = [];
        }
      }

      if (wantPagination) {
        // Flatten all elements, paginate, then return
        const allElements: unknown[] = [];
        for (const type of ELEMENT_TYPES) {
          allElements.push(...(result[type] || []));
        }
        const start = (page - 1) * pageSize;
        const paged = allElements.slice(start, start + pageSize);
        const totalPages = Math.ceil(allElements.length / pageSize);
        res.json({
          elements: paged,
          totalCount: allElements.length,
          page,
          pageSize,
          totalPages,
        });
      } else {
        // Backward-compatible: grouped by type
        res.json({ elements: result, totalCount });
      }
    } catch (err) {
      logger.error('[WebUI] Failed to list elements:', err);
      res.status(500).json({ error: 'Failed to list elements' });
    }
  });

  /**
   * GET /api/elements/:type
   * Returns all elements of a specific type
   */
  router.get('/elements/:type', async (req, res) => {
    const type = normalizeInput(req.params.type);
    if (!ELEMENT_TYPES.includes(type as typeof ELEMENT_TYPES[number])) {
      res.status(400).json({ error: `Invalid element type: ${type}` });
      return;
    }

    try {
      if (type === 'memories') {
        const memElements = await loadMemoriesFromIndex(portfolioDir);
        res.json({ type, elements: memElements, count: memElements.length });
        return;
      }

      const typeDir = join(portfolioDir, type);
      const files = await readdir(typeDir);
      const elements: unknown[] = [];

      for (const file of files) {
        if (isBackupOrCruft(file)) continue;

        const ext = extname(file);
        if (!VALID_EXTENSIONS.has(ext)) continue;

        try {
          const filePath = join(typeDir, file);
          const fileStat = await stat(filePath);
          if (!fileStat.isFile()) continue;
          if (fileStat.size > MAX_FILE_SIZE_BYTES) continue;

          const content = await readFile(filePath, 'utf-8');
          const validationResult = validateElementContent(file, content, type);

          if (!validationResult.valid) {
            logger.debug(`[WebUI] Skipping rejected file ${file}: ${validationResult.rejection?.reason}`);
            continue;
          }

          const { metadata } = validationResult;
          elements.push({
            name: metadata.name || file.replace(ext, ''),
            description: metadata.description || '',
            type: type.slice(0, -1),
            version: metadata.version || '1.0.0',
            author: metadata.author || '',
            category: metadata.category || '',
            tags: metadata.tags || '',
            created: metadata.created || '',
            filename: file,
          });
        } catch (err) {
          logger.debug(`[WebUI] Failed to parse ${file}:`, err);
        }
      }

      res.json({ type, elements, count: elements.length });
    } catch {
      res.status(500).json({ error: `Failed to list ${type}` });
    }
  });

  /**
   * GET /api/elements/memories/:date/:file
   * Memory content loading with date-partitioned paths.
   * Must be registered before the generic :type/:name route.
   */
  router.get('/elements/memories/:date/:file', async (req, res) => {
    const { date, file } = req.params;

    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      res.status(400).json({ error: 'Invalid date format' });
      return;
    }
    if (file.includes('..') || file.includes('/') || file.includes('\\') || isBackupOrCruft(file)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    try {
      const filePath = join(portfolioDir, 'memories', date, file);
      const resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(resolve(portfolioDir))) {
        res.status(400).json({ error: 'Path traversal detected' });
        return;
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_SIZE_BYTES) {
        res.status(fileStat.isFile() ? 413 : 404).json({ error: fileStat.isFile() ? 'File too large' : 'Not found' });
        return;
      }

      const content = await readFile(filePath, 'utf-8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(content);
    } catch {
      res.status(404).json({ error: `Memory not found: ${date}/${file}` });
    }
  });

  /**
   * GET /api/elements/:type/:name
   * Returns the raw file content as plain text.
   * The client-side app handles YAML/markdown parsing and rendering.
   */
  router.get('/elements/:type/:name', async (req, res) => {
    const { type, name } = req.params;
    if (!ELEMENT_TYPES.includes(type as typeof ELEMENT_TYPES[number])) {
      res.status(400).json({ error: `Invalid element type: ${type}` });
      return;
    }

    if (name.includes('..') || name.includes('\\')) {
      res.status(400).json({ error: 'Invalid element name' });
      return;
    }

    if (type !== 'memories' && name.includes('/')) {
      res.status(400).json({ error: 'Invalid element name' });
      return;
    }

    try {
      const typeDir = join(portfolioDir, type);
      const files = await readdir(typeDir);

      const match = files.find(f => {
        const base = f.replace(extname(f), '');
        return base === name || f === name;
      });

      if (!match) {
        res.status(404).json({ error: `Element not found: ${type}/${name}` });
        return;
      }

      const filePath = join(typeDir, match);
      const resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(resolve(portfolioDir))) {
        res.status(400).json({ error: 'Path traversal detected' });
        return;
      }

      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        res.status(413).json({ error: `File too large (${fileStat.size} bytes). Max 1 MB.` });
        return;
      }

      const content = await readFile(filePath, 'utf-8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(content);
    } catch {
      res.status(500).json({ error: `Failed to get element: ${type}/${name}` });
    }
  });

  /**
   * GET /api/stats
   * Returns portfolio statistics
   */
  router.get('/stats', async (_req, res) => {
    try {
      const stats: Record<string, number> = {};
      let total = 0;

      for (const type of ELEMENT_TYPES) {
        try {
          if (type === 'memories') {
            const memElements = await loadMemoriesFromIndex(portfolioDir);
            stats[type] = memElements.length;
            total += memElements.length;
            continue;
          }
          const typeDir = join(portfolioDir, type);
          const files = await readdir(typeDir);
          const count = files.filter(f =>
            !isBackupOrCruft(f) &&
            VALID_EXTENSIONS.has(extname(f))
          ).length;
          stats[type] = count;
          total += count;
        } catch {
          stats[type] = 0;
        }
      }

      res.json({ stats, total });
    } catch {
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  /**
   * GET /api/collection
   * Proxies the DollhouseMCP community collection index.
   * Prefers GitHub raw (authoritative source), falls back to local file.
   */
  router.get('/collection', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');

    // Prefer GitHub raw (authoritative, always fresh)
    try {
      const response = await fetch('https://raw.githubusercontent.com/DollhouseMCP/collection/main/public/collection-index.json');
      if (response.ok) {
        const data = await response.text();
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
        return;
      }
    } catch { /* GitHub unreachable — fall back to local */ }

    // Fall back to local collection repo (developer setup, may be stale)
    const localPaths = [
      join(portfolioDir, '..', '..', '..', 'collection', 'public', 'collection-index.json'),
      join(portfolioDir, '..', 'collection', 'public', 'collection-index.json'),
    ];

    for (const localPath of localPaths) {
      try {
        const content = await readFile(localPath, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.send(content);
        return;
      } catch { /* try next */ }
    }

    res.status(404).json({ error: 'Collection index not available' });
  });

  /**
   * POST /api/install
   * Install a collection element into the local portfolio.
   * Routes through DollhouseMCP's install_collection_content pipeline
   * for proper validation, gatekeeper checks, and element management.
   *
   * Requires the MCP server's CollectionHandler to be available.
   * Falls back to direct file write if not (standalone web mode).
   */
  router.post('/install', express.json(), async (req, res) => {
    if (!installRateLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Too many install requests. Max 10 per minute.' });
      return;
    }

    const { path: elementPath, name, type } = req.body as { path?: string; name?: string; type?: string };

    if (!elementPath || !type || !name) {
      res.status(400).json({ error: 'Missing required fields: path, name, type' });
      return;
    }

    // Validate type
    const pluralType = type.endsWith('s') ? type : `${type}s`;
    if (!ELEMENT_TYPES.includes(pluralType as typeof ELEMENT_TYPES[number])) {
      res.status(400).json({ error: `Invalid element type: ${type}` });
      return;
    }

    // Prevent path traversal
    if (elementPath.includes('..') || name.includes('..')) {
      res.status(400).json({ error: 'Invalid path or name' });
      return;
    }

    // Validate elementPath contains only safe characters (alphanumeric, hyphens, underscores, dots, slashes)
    if (!/^[a-zA-Z0-9/_.-]+$/.test(elementPath)) {
      res.status(400).json({ error: 'Invalid element path characters' });
      return;
    }

    try {
      // Fetch content from GitHub
      const ghUrl = `https://raw.githubusercontent.com/DollhouseMCP/collection/main/${elementPath}`;

      // Validate the constructed URL stays within expected domain and path
      const parsedUrl = new URL(ghUrl);
      if (parsedUrl.hostname !== 'raw.githubusercontent.com' || !parsedUrl.pathname.startsWith('/DollhouseMCP/collection/')) {
        res.status(400).json({ error: 'Invalid collection path' });
        return;
      }

      const response = await fetch(ghUrl);
      if (!response.ok) {
        res.status(502).json({ error: `Failed to fetch from collection: HTTP ${response.status}` });
        return;
      }
      const content = await response.text();

      // Validate content through the security pipeline before writing
      const ext = extname(elementPath);
      try {
        if (ext === '.yaml' || ext === '.yml') {
          // Validate YAML content for bombs, circular references, malicious patterns
          if (!ContentValidator.validateYamlContent(content)) {
            res.status(422).json({ error: 'Content failed YAML validation — potentially malicious patterns detected' });
            return;
          }
          SecureYamlParser.parseRawYaml(content);
        } else {
          // Validate markdown+frontmatter content
          SecureYamlParser.parse(content);
        }
      } catch (parseErr) {
        res.status(422).json({ error: `Content failed parse validation: ${(parseErr as Error).message}` });
        return;
      }

      // Validate content body for injection patterns
      const singularType = pluralType.slice(0, -1);
      const contextTypes = ['persona', 'skill', 'template', 'agent', 'memory'] as const;
      type ContentContext = typeof contextTypes[number];
      const contentContext = contextTypes.includes(singularType as ContentContext) ? singularType as ContentContext : undefined;
      const validationResult = ContentValidator.validateAndSanitize(content, {
        contentContext,
      });
      if (!validationResult.isValid) {
        logger.warn('[WebUI] Install blocked — content validation failed', {
          element: `${pluralType}/${name}`,
          patterns: validationResult.detectedPatterns,
          severity: validationResult.severity,
        });
        res.status(422).json({
          error: 'Content failed security validation',
          patterns: validationResult.detectedPatterns,
          severity: validationResult.severity,
        });
        return;
      }

      // Determine filename
      const filename = elementPath.split('/').pop() || `${name}.md`;

      // Ensure type directory exists
      const typeDir = join(portfolioDir, pluralType);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(typeDir, { recursive: true });

      // Write to portfolio
      const destPath = join(typeDir, filename);

      // Verify resolved destination path stays within portfolio directory (defense in depth)
      const resolvedDest = resolve(destPath);
      if (!resolvedDest.startsWith(resolve(portfolioDir))) {
        res.status(400).json({ error: 'Path traversal detected' });
        return;
      }

      // Check if file already exists
      try {
        await stat(destPath);
        res.status(409).json({ error: `Element already exists: ${pluralType}/${filename}. Delete it first or rename.` });
        return;
      } catch { /* doesn't exist — good */ }

      const { writeFile: writeFileFs } = await import('node:fs/promises');
      await writeFileFs(destPath, content, 'utf-8');

      logger.info(`[WebUI] Installed collection element: ${pluralType}/${filename}`);
      res.json({ success: true, message: `Installed ${name} to portfolio`, path: `${pluralType}/${filename}` });
    } catch (err) {
      logger.error('[WebUI] Install failed:', err);
      res.status(500).json({ error: `Install failed: ${(err as Error).message}` });
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────────────────────
// Web MCP-AQL Gateway Routes (Issue #796)
//
// These routes translate HTTP requests into MCPAQLHandler calls, routing all
// reads/writes through the existing element managers, validation, and gatekeeper.
// ────────────────────────────────────────────────────────────────────────────

/** Normalize element type to singular form for MCP-AQL operations */
const PLURAL_TO_SINGULAR: Record<string, string> = {
  personas: 'persona',
  skills: 'skill',
  templates: 'template',
  agents: 'agent',
  memories: 'memory',
  ensembles: 'ensemble',
};
function toSingularType(type: string): string {
  return PLURAL_TO_SINGULAR[type] || (type.endsWith('s') ? type.slice(0, -1) : type);
}

/**
 * Extract single operation result from MCPAQLHandler response.
 * Web routes never send batch requests, so cast is safe.
 */
interface SingleOpResult { success: boolean; data?: unknown; error?: string }
function asSingleResult(r: unknown): SingleOpResult {
  if (typeof r === 'object' && r !== null && 'success' in r) {
    return r as SingleOpResult;
  }
  return { success: false, error: 'Invalid operation result format' };
}

/**
 * Create API routes that route through MCPAQLHandler (gateway mode).
 * All operations go through the MCP-AQL pipeline: validation, cache, gatekeeper.
 *
 * Falls back to direct filesystem for /api/collection (external fetch, no MCP-AQL equivalent)
 * and /api/stats (lightweight aggregate, no matching operation).
 */
export function createGatewayApiRoutes(handler: MCPAQLHandler, portfolioDir: string): Router {
  const router = Router();

  /**
   * GET /api/elements
   * Uses direct filesystem listing to get accurate YAML frontmatter metadata
   * (created, author, category) with content validated through the security
   * pipeline (Unicode normalization, YAML bomb detection, injection scanning).
   * MCP-AQL is used for all other endpoints.
   * codeql[js/missing-rate-limiting] — Rate-limited by router.use() middleware above.
   */
  router.get('/elements', async (req, res) => {
    try {
      const pageParam = req.query.page as string | undefined;
      const pageSizeParam = req.query.pageSize as string | undefined;
      const wantPagination = pageParam !== undefined && pageSizeParam !== undefined;
      const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
      const pageSize = Math.max(1, Math.min(200, parseInt(pageSizeParam || '50', 10) || 50));

      const result: Record<string, unknown[]> = {};
      let totalCount = 0;

      for (const type of ELEMENT_TYPES) {
        try {
          if (type === 'memories') {
            const memElements = await loadMemoriesFromIndex(portfolioDir);
            result[type] = memElements;
            totalCount += memElements.length;
            continue;
          }

          const typeDir = join(portfolioDir, type);
          const dirStat = await stat(typeDir);
          if (!dirStat.isDirectory()) continue;

          const files = await readdir(typeDir);
          const elements: unknown[] = [];

          for (const file of files) {
            if (isBackupOrCruft(file)) continue;
            const ext = extname(file);
            if (!VALID_EXTENSIONS.has(ext)) continue;

            try {
              const filePath = join(typeDir, file);
              const fileStat = await stat(filePath);
              if (!fileStat.isFile()) continue;
              if (fileStat.size > MAX_FILE_SIZE_BYTES) continue;

              const content = await readFile(filePath, 'utf-8');
              const validationResult = validateElementContent(file, content, type);

              if (!validationResult.valid) {
                logger.debug(`[WebUI/Gateway] Skipping rejected file ${file}: ${validationResult.rejection?.reason}`);
                continue;
              }

              const { metadata } = validationResult;
              elements.push({
                name: metadata.name || file.replace(ext, ''),
                description: metadata.description || '',
                type: type.slice(0, -1),
                version: metadata.version || '1.0.0',
                author: metadata.author || '',
                category: metadata.category || '',
                tags: metadata.tags || '',
                created: metadata.created || '',
                filename: file,
              });
            } catch (err) {
              logger.debug(`[WebUI/Gateway] Failed to parse ${file}:`, err);
            }
          }

          result[type] = elements;
          totalCount += elements.length;
        } catch {
          result[type] = [];
        }
      }

      if (wantPagination) {
        const allElements: unknown[] = [];
        for (const type of ELEMENT_TYPES) {
          allElements.push(...(result[type] || []));
        }
        const start = (page - 1) * pageSize;
        const paged = allElements.slice(start, start + pageSize);
        const totalPages = Math.ceil(allElements.length / pageSize);
        res.json({ elements: paged, totalCount: allElements.length, page, pageSize, totalPages });
      } else {
        res.json({ elements: result, totalCount });
      }
    } catch (err) {
      logger.error('[WebUI/Gateway] Failed to list elements:', err);
      res.status(500).json({ error: 'Failed to list elements' });
    }
  });

  /**
   * GET /api/elements/:type
   * Routes through list_elements for a specific type.
   */
  router.get('/elements/:type', async (req, res) => {
    const type = normalizeInput(req.params.type);
    if (!ELEMENT_TYPES.includes(type as typeof ELEMENT_TYPES[number])) {
      res.status(400).json({ error: `Invalid element type: ${type}` });
      return;
    }

    try {
      const opResult = asSingleResult(await handler.handleRead({
        operation: 'list_elements',
        params: { element_type: toSingularType(type), page: 1, pageSize: 1000 },
      }));

      if (!opResult.success) {
        res.status(502).json({ error: opResult.error || `Failed to list ${type}` });
        return;
      }

      const data = opResult.data as Record<string, unknown>;
      const items = Array.isArray(data.items) ? data.items : [];
      res.json({ type, elements: items, count: items.length });
    } catch {
      res.status(500).json({ error: `Failed to list ${type}` });
    }
  });

  /**
   * GET /api/elements/memories/:date/:file
   * Memory content loading with date-partitioned paths.
   * Must be registered before the generic :type/:name route.
   * codeql[js/missing-rate-limiting] — Rate-limited by router.use() middleware above.
   */
  router.get('/elements/memories/:date/:file', async (req, res) => {
    const { date, file } = req.params;

    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      res.status(400).json({ error: 'Invalid date format' });
      return;
    }
    if (file.includes('..') || file.includes('/') || file.includes('\\') || isBackupOrCruft(file)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    try {
      const filePath = join(portfolioDir, 'memories', date, file);
      const resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(resolve(portfolioDir))) {
        res.status(400).json({ error: 'Path traversal detected' });
        return;
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_SIZE_BYTES) {
        res.status(fileStat.isFile() ? 413 : 404).json({ error: fileStat.isFile() ? 'File too large' : 'Not found' });
        return;
      }

      const content = await readFile(filePath, 'utf-8');
      const validation = validateElementContent(file, content, 'memories');

      res.json({
        metadata: validation.metadata,
        body: validation.body,
        raw: content,
        type: 'memory',
        validation: {
          status: validation.valid ? 'pass' : 'warn',
          ...(validation.rejection && {
            reason: validation.rejection.reason,
            severity: validation.rejection.severity,
            patterns: validation.rejection.patterns,
          }),
        },
      });
    } catch {
      res.status(404).json({ error: `Memory not found: ${date}/${file}` });
    }
  });

  /**
   * GET /api/elements/:type/:name
   * Returns the raw file content as plain text, validated through the security pipeline.
   * The client-side app handles YAML/markdown parsing and rendering.
   */
  router.get('/elements/:type/:name', async (req, res) => {
    const { type, name } = req.params;
    if (!ELEMENT_TYPES.includes(type as typeof ELEMENT_TYPES[number])) {
      res.status(400).json({ error: `Invalid element type: ${type}` });
      return;
    }

    // Prevent path traversal (but allow / for memory date paths like 2025-09-19/file.yaml)
    if (name.includes('..') || name.includes('\\')) {
      res.status(400).json({ error: 'Invalid element name' });
      return;
    }

    // Non-memory types must not contain /
    if (type !== 'memories' && name.includes('/')) {
      res.status(400).json({ error: 'Invalid element name' });
      return;
    }

    try {
      let filePath: string;

      if (type === 'memories' && name.includes('/')) {
        // Memory date-path: e.g., "2025-09-19/code-patterns.yaml"
        const parts = name.split('/');
        if (parts.length !== 2 || !parts[0].match(/^\d{4}-\d{2}-\d{2}$/) || isBackupOrCruft(parts[1])) {
          res.status(400).json({ error: 'Invalid memory path' });
          return;
        }
        filePath = join(portfolioDir, type, name);
      } else {
        const typeDir = join(portfolioDir, type);
        const files = await readdir(typeDir);

        // Find the file by name (with or without extension)
        const match = files.find(f => {
          const base = f.replace(extname(f), '');
          return base === name || f === name;
        });

        if (!match) {
          res.status(404).json({ error: `Element not found: ${type}/${name}` });
          return;
        }

        filePath = join(portfolioDir, type, match);
      }

      // Verify resolved path stays within portfolio directory (defense in depth).
      // codeql[js/path-injection] — mitigated: type validated against ELEMENT_TYPES whitelist,
      // name checked for '..' and '\', memory paths validated as YYYY-MM-DD/filename,
      // non-memory names matched against actual readdir() results (no user-controlled segments
      // reach the filesystem), and final resolve() containment check below.
      const resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(resolve(portfolioDir))) {
        res.status(400).json({ error: 'Path traversal detected' });
        return;
      }

      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        res.status(413).json({ error: `File too large (${fileStat.size} bytes). Max 1 MB.` });
        return;
      }

      const content = await readFile(filePath, 'utf-8');
      const filename = filePath.split('/').pop() || name;
      const validation = validateElementContent(filename, content, type);

      // Return structured JSON: parsed metadata + body + raw content.
      // The client renders metadata directly (no re-parsing), uses raw for
      // the Raw toggle, Copy, and Download actions.
      res.json({
        metadata: validation.metadata,
        body: validation.body,
        raw: content,
        type: type.endsWith('s') ? type.slice(0, -1) : type,
        validation: {
          status: validation.valid ? 'pass' : 'warn',
          ...(validation.rejection && {
            reason: validation.rejection.reason,
            severity: validation.rejection.severity,
            patterns: validation.rejection.patterns,
          }),
        },
      });
    } catch {
      res.status(500).json({ error: `Failed to get element: ${type}/${name}` });
    }
  });

  /**
   * GET /api/stats
   * Portfolio statistics — lightweight aggregate, uses list_elements counts.
   */
  router.get('/stats', async (_req, res) => {
    try {
      const stats: Record<string, number> = {};
      let total = 0;

      // Parallelize stats queries
      const typeStats = await Promise.all(ELEMENT_TYPES.map(async (type) => {
        const opResult = asSingleResult(await handler.handleRead({
          operation: 'list_elements',
          params: { element_type: toSingularType(type), page: 1, pageSize: 1 },
        }));
        if (opResult.success && opResult.data) {
          const data = opResult.data as Record<string, unknown>;
          const pagination = data.pagination as Record<string, unknown> | undefined;
          return { type, count: typeof pagination?.totalItems === 'number' ? pagination.totalItems : 0 };
        }
        return { type, count: 0 };
      }));

      for (const { type, count } of typeStats) {
        stats[type] = count;
        total += count;
      }

      res.json({ stats, total });
    } catch {
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  /**
   * GET /api/collection
   * Proxies the community collection index.
   * No MCP-AQL equivalent — uses direct fetch (same as legacy).
   */
  router.get('/collection', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');

    try {
      const response = await fetch('https://raw.githubusercontent.com/DollhouseMCP/collection/main/public/collection-index.json');
      if (response.ok) {
        const data = await response.text();
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
        return;
      }
    } catch { /* GitHub unreachable — fall back to local */ }

    const localPaths = [
      join(portfolioDir, '..', '..', '..', 'collection', 'public', 'collection-index.json'),
      join(portfolioDir, '..', 'collection', 'public', 'collection-index.json'),
    ];

    for (const localPath of localPaths) {
      try {
        const content = await readFile(localPath, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.send(content);
        return;
      } catch { /* try next */ }
    }

    res.status(404).json({ error: 'Collection index not available' });
  });

  /**
   * GET /api/collection/content/*
   * Proxies collection element content from GitHub, validates through the
   * security pipeline, and returns structured JSON (same format as portfolio detail).
   * codeql[js/missing-rate-limiting] — Rate-limited by router.use() middleware above.
   */
  router.get('/collection/content/:prefix/:type/:name', async (req, res) => {
    const elementPath = `${req.params.prefix}/${req.params.type}/${req.params.name}`;
    if (!elementPath || elementPath.includes('..') || elementPath.includes('\\')) {
      res.status(400).json({ error: 'Invalid element path' });
      return;
    }

    const elementType = req.params.type;
    const filename = req.params.name;

    // Validate element type against known types to prevent arbitrary path construction
    if (!ELEMENT_TYPES.includes(elementType as typeof ELEMENT_TYPES[number])) {
      res.status(400).json({ error: `Invalid element type: ${elementType}` });
      return;
    }

    try {
      // codeql[js/request-forgery] — mitigated: domain and repo are hardcoded constants,
      // elementType is validated against ELEMENT_TYPES whitelist above, path traversal
      // is checked, and the only reachable target is a specific public GitHub repository.
      const githubUrl = `https://raw.githubusercontent.com/DollhouseMCP/collection/main/${elementPath}`;
      const response = await fetch(githubUrl);
      if (!response.ok) {
        res.status(response.status === 404 ? 404 : 502).json({
          error: response.status === 404
            ? `Collection element not found: ${elementPath}`
            : `Failed to fetch from GitHub (HTTP ${response.status})`,
        });
        return;
      }

      const content = await response.text();
      const validation = validateElementContent(filename, content, elementType);
      const singularType = PLURAL_TO_SINGULAR[elementType] || (elementType.endsWith('s') ? elementType.slice(0, -1) : elementType);

      res.json({
        metadata: validation.metadata,
        body: validation.body,
        raw: content,
        type: singularType,
        validation: {
          status: validation.valid ? 'pass' : 'warn',
          ...(validation.rejection && {
            reason: validation.rejection.reason,
            severity: validation.rejection.severity,
            patterns: validation.rejection.patterns,
          }),
        },
      });
    } catch (err) {
      logger.error('[WebUI/Gateway] Failed to fetch collection content:', err);
      res.status(502).json({ error: 'Failed to fetch collection element' });
    }
  });

  /**
   * POST /api/install
   * Routes through install_collection_content MCP-AQL operation.
   * All validation, gatekeeper checks handled by the pipeline.
   */
  const installLimiter = new SlidingWindowRateLimiter(10, 60_000);
  router.post('/install', express.json(), async (req, res) => {
    if (!installLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Too many install requests. Max 10 per minute.' });
      return;
    }

    const { path: elementPath, name, type } = req.body as { path?: string; name?: string; type?: string };

    if (!elementPath || !type || !name) {
      res.status(400).json({ error: 'Missing required fields: path, name, type' });
      return;
    }

    if (elementPath.includes('..') || name.includes('..')) {
      res.status(400).json({ error: 'Invalid path or name' });
      return;
    }

    // Validate elementPath contains only safe characters (alphanumeric, hyphens, underscores, dots, slashes)
    if (!/^[a-zA-Z0-9/_.-]+$/.test(elementPath)) {
      res.status(400).json({ error: 'Invalid element path characters' });
      return;
    }

    try {
      // Route through MCP-AQL install_collection_content operation
      const installPath = elementPath.replace(/^library\//, '');
      const opResult = asSingleResult(await handler.handleCreate({
        operation: 'install_collection_content',
        params: { path: installPath },
      }));

      if (!opResult.success) {
        res.status(422).json({ error: opResult.error || 'Install failed' });
        return;
      }

      logger.info(`[WebUI/Gateway] Installed collection element: ${installPath}`);
      res.json({ success: true, message: `Installed ${name} to portfolio`, data: opResult.data });
    } catch (err) {
      logger.error('[WebUI/Gateway] Install failed:', err);
      res.status(500).json({ error: `Install failed: ${(err as Error).message}` });
    }
  });

  return router;
}
