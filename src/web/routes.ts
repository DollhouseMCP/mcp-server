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
import { validateElementContent, type PipelineResult } from './contentPipeline.js';
import type { MCPAQLHandler } from '../handlers/mcp-aql/MCPAQLHandler.js';

/** Normalize user input to NFC form to prevent Unicode homograph attacks */
function normalizeInput(input: string): string {
  return input.normalize('NFC');
}
import { ContentValidator } from '../security/contentValidator.js';
import { SlidingWindowRateLimiter } from '../utils/SlidingWindowRateLimiter.js';

const ELEMENT_TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'] as const;

/** Max file size for element reads (1 MB) */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/** Valid element file extensions */
const VALID_EXTENSIONS = new Set(['.md', '.yaml', '.yml']);

/** Known-safe filename pattern: starts alphanumeric, body allows hyphens/underscores, valid extension */
const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(yaml|yml|md)$/;

/** Check if a filename is a backup or cruft file */
function isBackupOrCruft(filename: string): boolean {
  // Guaranteed safe filenames skip blacklist checks entirely
  if (SAFE_FILENAME_RE.test(filename)) return false;
  if (filename.startsWith('.')) return true;
  if (filename === '_index.json') return true;
  if (filename.includes('.backup') || filename.includes('.state')) return true;
  if (filename.endsWith('.bak') || filename.endsWith('~')) return true;
  if (filename.includes(' copy')) return true;
  return false;
}

/**
 * Scan a directory for valid elements, running each through the security
 * validation pipeline. Returns metadata objects ready for API responses.
 */
async function scanElementDirectory(typeDir: string, type: string, logPrefix: string): Promise<unknown[]> {
  const files = await readdir(typeDir);
  const elements: unknown[] = [];

  for (const file of files) {
    if (isBackupOrCruft(file)) continue;
    const ext = extname(file);
    if (!VALID_EXTENSIONS.has(ext)) continue;

    try {
      const filePath = join(typeDir, file);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_SIZE_BYTES) continue;

      const content = await readFile(filePath, 'utf-8');
      const validationResult = validateElementContent(file, content, type);

      if (!validationResult.valid) {
        logger.debug(`${logPrefix} Skipping rejected file ${file}: ${validationResult.rejection?.reason}`);
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
      logger.debug(`${logPrefix} Failed to parse ${file}:`, err);
    }
  }

  return elements;
}

/** Normalize plural element type to singular form */
const PLURAL_TO_SINGULAR: Record<string, string> = {
  personas: 'persona', skills: 'skill', templates: 'template',
  agents: 'agent', memories: 'memory', ensembles: 'ensemble',
};
function toSingularType(type: string): string {
  return PLURAL_TO_SINGULAR[type] || (type.endsWith('s') ? type.slice(0, -1) : type);
}

/** Build a structured validation response for element detail routes */
function buildValidationResponse(validation: PipelineResult, content: string, type: string) {
  return {
    metadata: validation.metadata,
    body: validation.body,
    raw: content,
    type: toSingularType(type),
    validation: {
      status: validation.valid ? 'pass' : 'warn',
      ...(validation.rejection && {
        reason: validation.rejection.reason,
        severity: validation.rejection.severity,
        patterns: validation.rejection.patterns,
      }),
    },
  };
}

/**
 * Resolve a file path for an element, handling memory date-paths
 * and name-with-or-without-extension matching.
 * Returns the resolved path or null with an error to send.
 */
async function resolveElementFilePath(
  portfolioDir: string, type: string, name: string
): Promise<{ filePath: string } | { error: string; status: number }> {
  if (type === 'memories' && name.includes('/')) {
    const parts = name.split('/');
    if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0]) || isBackupOrCruft(parts[1])) {
      return { error: 'Invalid memory path', status: 400 };
    }
    const filePath = join(portfolioDir, type, name);
    const resolvedPath = resolve(filePath);
    if (!resolvedPath.startsWith(resolve(portfolioDir))) {
      return { error: 'Path traversal detected', status: 400 };
    }
    return { filePath };
  }

  const typeDir = join(portfolioDir, type);
  const files = await readdir(typeDir);
  const match = files.find(f => {
    const base = f.replace(extname(f), '');
    return base === name || f === name;
  });

  if (!match) {
    return { error: `Element not found: ${type}/${name}`, status: 404 };
  }

  const filePath = join(portfolioDir, type, match);
  const resolvedPath = resolve(filePath);
  if (!resolvedPath.startsWith(resolve(portfolioDir))) {
    return { error: 'Path traversal detected', status: 400 };
  }
  return { filePath };
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

/**
 * Register portfolio routes shared between simple and gateway modes.
 * The structuredDetail option controls whether detail routes return
 * structured JSON (gateway) or plain text (simple/legacy).
 */
function registerPortfolioRoutes(
  router: Router,
  portfolioDir: string,
  options: { structuredDetail: boolean; logPrefix: string },
): void {
  const { structuredDetail, logPrefix } = options;

  router.get('/elements', async (req, res) => {
    try {
      const pageParam = req.query.page as string | undefined;
      const pageSizeParam = req.query.pageSize as string | undefined;
      const wantPagination = pageParam !== undefined && pageSizeParam !== undefined;
      const page = Math.max(1, Number.parseInt(pageParam || '1', 10) || 1);
      const pageSize = Math.max(1, Math.min(200, Number.parseInt(pageSizeParam || '50', 10) || 50));

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

          const elements = await scanElementDirectory(typeDir, type, logPrefix);
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
      logger.error(`${logPrefix} Failed to list elements:`, err);
      res.status(500).json({ error: 'Failed to list elements' });
    }
  });

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

      const elements = await scanElementDirectory(join(portfolioDir, type), type, logPrefix);
      res.json({ type, elements, count: elements.length });
    } catch {
      res.status(500).json({ error: `Failed to list ${type}` });
    }
  });

  router.get('/elements/memories/:date/:file', async (req, res) => {
    const { date, file } = req.params;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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
      if (structuredDetail) {
        const validation = validateElementContent(file, content, 'memories');
        res.json(buildValidationResponse(validation, content, 'memories'));
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(content);
      }
    } catch {
      res.status(404).json({ error: `Memory not found: ${date}/${file}` });
    }
  });

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
      const resolved = await resolveElementFilePath(portfolioDir, type, name);
      if ('error' in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const fileStat = await stat(resolved.filePath);
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        res.status(413).json({ error: `File too large (${fileStat.size} bytes). Max 1 MB.` });
        return;
      }

      const content = await readFile(resolved.filePath, 'utf-8');
      if (structuredDetail) {
        const filename = resolved.filePath.split('/').pop() || name;
        const validation = validateElementContent(filename, content, type);
        res.json(buildValidationResponse(validation, content, type));
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(content);
      }
    } catch {
      res.status(500).json({ error: `Failed to get element: ${type}/${name}` });
    }
  });
}

/** Register filesystem-based stats route (shared between simple and gateway) */
function registerStatsRoute(router: Router, portfolioDir: string): void {
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
          const count = files.filter(f => !isBackupOrCruft(f) && VALID_EXTENSIONS.has(extname(f))).length;
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
}

/** Register collection index proxy route (shared between simple and gateway) */
function registerCollectionRoute(router: Router, portfolioDir: string): void {
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
}

export function createApiRoutes(portfolioDir: string): Router {
  const router = Router();

  registerPortfolioRoutes(router, portfolioDir, { structuredDetail: false, logPrefix: '[WebUI]' });

  registerStatsRoute(router, portfolioDir);
  registerCollectionRoute(router, portfolioDir);

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

  // Shared portfolio routes — structured JSON for detail views
  // codeql[js/missing-rate-limiting] — Rate-limited by router.use() middleware in server.ts
  registerPortfolioRoutes(router, portfolioDir, { structuredDetail: true, logPrefix: '[WebUI/Gateway]' });
  registerStatsRoute(router, portfolioDir);
  registerCollectionRoute(router, portfolioDir);

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
