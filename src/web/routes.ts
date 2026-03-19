/**
 * Web UI API Routes
 *
 * REST endpoints for reading portfolio elements.
 * Read-only — no mutations in V1.
 *
 * All element content is sanitized before serving to prevent XSS.
 */

import express, { Router } from 'express';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { logger } from '../utils/logger.js';
import type { MCPAQLHandler } from '../handlers/mcp-aql/MCPAQLHandler.js';

/** Normalize user input to NFC form to prevent Unicode homograph attacks */
function normalizeInput(input: string): string {
  return input.normalize('NFC');
}
import { ContentValidator } from '../security/contentValidator.js';

const ELEMENT_TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'] as const;

/** Max file size for element reads (1 MB) */
const MAX_FILE_SIZE_BYTES = 1_048_576;

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
        const typeDir = join(portfolioDir, type);
        try {
          const dirStat = await stat(typeDir);
          if (!dirStat.isDirectory()) continue;

          const files = await readdir(typeDir);
          const elements: unknown[] = [];

          for (const file of files) {
            // Skip backups, hidden files, state files
            if (file.startsWith('.') || file.includes('.backup-') || file.includes('.state')) continue;

            const ext = extname(file);
            if (ext !== '.md' && ext !== '.yaml' && ext !== '.yml') continue;

            try {
              const filePath = join(typeDir, file);

              // Skip files larger than 1 MB
              const fileStat = await stat(filePath);
              if (fileStat.size > MAX_FILE_SIZE_BYTES) {
                logger.debug(`[WebUI] Skipping oversized file (${fileStat.size} bytes): ${file}`);
                continue;
              }

              const content = await readFile(filePath, 'utf-8');
              const { metadata } = ext === '.md' ? parseFrontMatter(content) : parseYamlFile(content);

              elements.push({
                name: metadata.name || file.replace(ext, ''),
                description: metadata.description || '',
                type: type.slice(0, -1), // plural → singular
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
      const typeDir = join(portfolioDir, type);
      const files = await readdir(typeDir);
      const elements: unknown[] = [];

      for (const file of files) {
        if (file.startsWith('.') || file.includes('.backup-') || file.includes('.state')) continue;

        const ext = extname(file);
        if (ext !== '.md' && ext !== '.yaml' && ext !== '.yml') continue;

        try {
          const filePath = join(typeDir, file);

          // Skip files larger than 1 MB
          const fileStat = await stat(filePath);
          if (fileStat.size > MAX_FILE_SIZE_BYTES) {
            logger.debug(`[WebUI] Skipping oversized file (${fileStat.size} bytes): ${file}`);
            continue;
          }

          const content = await readFile(filePath, 'utf-8');
          const { metadata, body } = ext === '.md' ? parseFrontMatter(content) : parseYamlFile(content);

          elements.push({
            name: metadata.name || file.replace(ext, ''),
            description: metadata.description || '',
            type: type.slice(0, -1),
            version: metadata.version || '1.0.0',
            author: metadata.author || '',
            category: metadata.category || '',
            tags: metadata.tags || '',
            created: metadata.created || '',
            modified: metadata.modified || '',
            filename: file,
            bodyPreview: sanitizeForHtml(body.slice(0, 500)),
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

    // Prevent path traversal
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      res.status(400).json({ error: 'Invalid element name' });
      return;
    }

    try {
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

      const filePath = join(typeDir, match);

      // Reject files larger than 1 MB
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        res.status(413).json({ error: `File too large (${fileStat.size} bytes). Max 1 MB.` });
        return;
      }

      const content = await readFile(filePath, 'utf-8');

      // Return raw text — client-side handles parsing/rendering
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
          const typeDir = join(portfolioDir, type);
          const files = await readdir(typeDir);
          const count = files.filter(f =>
            !f.startsWith('.') &&
            !f.includes('.backup-') &&
            !f.includes('.state') &&
            ['.md', '.yaml', '.yml'].includes(extname(f))
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

    try {
      // Fetch content from GitHub
      const ghUrl = `https://raw.githubusercontent.com/DollhouseMCP/collection/main/${elementPath}`;
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
function toSingularType(type: string): string {
  return type.endsWith('s') ? type.slice(0, -1) : type;
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
   * Routes through list_elements for each type, aggregates results.
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

      // Parallelize element type listing for better performance
      const typeResults = await Promise.all(ELEMENT_TYPES.map(async (type) => {
        const opResult = asSingleResult(await handler.handleRead({
          operation: 'list_elements',
          params: { element_type: toSingularType(type), page: 1, pageSize: 1000 },
        }));
        if (opResult.success && opResult.data) {
          const items = (opResult.data as Record<string, unknown>).items;
          return { type, items: Array.isArray(items) ? items : [] };
        }
        return { type, items: [] as unknown[] };
      }));

      for (const { type, items } of typeResults) {
        result[type] = items;
        totalCount += items.length;
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
        res.status(500).json({ error: opResult.error || `Failed to list ${type}` });
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
   * GET /api/elements/:type/:name
   * Routes through get_element for a specific element.
   * Returns the raw file content as plain text (same as legacy behavior).
   */
  router.get('/elements/:type/:name', async (req, res) => {
    const { type, name } = req.params;
    if (!ELEMENT_TYPES.includes(type as typeof ELEMENT_TYPES[number])) {
      res.status(400).json({ error: `Invalid element type: ${type}` });
      return;
    }

    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      res.status(400).json({ error: 'Invalid element name' });
      return;
    }

    try {
      const opResult = asSingleResult(await handler.handleRead({
        operation: 'get_element',
        params: { element_name: name, element_type: toSingularType(type) },
      }));

      if (!opResult.success) {
        const errMsg = opResult.error || '';
        const status = errMsg.toLowerCase().includes('not found') ? 404 : 500;
        res.status(status).json({ error: errMsg || `Failed to get element: ${type}/${name}` });
        return;
      }

      // get_element returns structured data — the web UI expects raw file content
      // for client-side parsing. Extract rawContent if available, otherwise serialize.
      const data = opResult.data as Record<string, unknown>;
      const rawContent = data.rawContent || data.raw_content;
      if (typeof rawContent === 'string') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(rawContent);
      } else {
        // Fallback: return JSON representation
        res.json(data);
      }
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
