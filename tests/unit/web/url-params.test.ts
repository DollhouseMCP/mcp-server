/**
 * Unit tests for URL parameter parsing and mapping functions.
 *
 * The management console uses fragment-query URLs (#tab?key=value) for
 * deep-linking. These tests validate the parsing logic, sort mapping,
 * and edge case handling.
 *
 * @see Issue #1765 - URL parameter support for portfolio browser
 */

describe('URL parameter parsing', () => {
  /**
   * Extracted getTabAndParams logic — mirrors src/web/public/app.js.
   * We test the parsing function rather than wiring up actual window.location.
   */
  function getTabAndParams(hash: string): { tab: string; params: URLSearchParams } {
    const raw = hash.replace('#', '');
    if (raw.length > 2048) return { tab: '', params: new URLSearchParams() };
    const qIdx = raw.indexOf('?');
    if (qIdx === -1) return { tab: raw, params: new URLSearchParams() };
    return {
      tab: raw.substring(0, qIdx),
      params: new URLSearchParams(raw.substring(qIdx + 1)),
    };
  }

  describe('getTabAndParams', () => {
    it('should parse tab name from hash', () => {
      const { tab, params } = getTabAndParams('#portfolio');
      expect(tab).toBe('portfolio');
      expect(params.toString()).toBe('');
    });

    it('should parse tab with query params', () => {
      const { tab, params } = getTabAndParams('#logs?level=error&since=1h');
      expect(tab).toBe('logs');
      expect(params.get('level')).toBe('error');
      expect(params.get('since')).toBe('1h');
    });

    it('should handle empty hash', () => {
      const { tab, params } = getTabAndParams('#');
      expect(tab).toBe('');
      expect(params.toString()).toBe('');
    });

    it('should handle hash with no tab but params', () => {
      const { tab, params } = getTabAndParams('#?q=test');
      expect(tab).toBe('');
      expect(params.get('q')).toBe('test');
    });

    it('should handle multiple params', () => {
      const { tab, params } = getTabAndParams('#portfolio?q=axiom&type=persona&sort=updated');
      expect(tab).toBe('portfolio');
      expect(params.get('q')).toBe('axiom');
      expect(params.get('type')).toBe('persona');
      expect(params.get('sort')).toBe('updated');
    });

    it('should handle URL-encoded values', () => {
      const { params } = getTabAndParams('#portfolio?q=hello%20world');
      expect(params.get('q')).toBe('hello world');
    });

    it('should return empty for excessively long URLs', () => {
      const longHash = '#portfolio?' + 'x='.repeat(1500);
      const { tab, params } = getTabAndParams(longHash);
      expect(tab).toBe('');
      expect(params.toString()).toBe('');
    });

    it('should handle unknown params gracefully', () => {
      const { tab, params } = getTabAndParams('#portfolio?foo=bar&unknown=value');
      expect(tab).toBe('portfolio');
      expect(params.get('foo')).toBe('bar');
    });

    it('should handle bare hash without #', () => {
      const { tab } = getTabAndParams('portfolio');
      expect(tab).toBe('portfolio');
    });
  });
});

describe('Sort parameter mapping', () => {
  /**
   * Extracted mapSortParams logic — mirrors src/web/public/app.js.
   */
  function mapSortParams(sort = 'name', order = 'asc'): string {
    if (sort === 'name') return `name-${order}`;
    if (sort === 'updated' || sort === 'created') return `date-${order}`;
    return `${sort}-${order}`;
  }

  it('should map name+asc to name-asc', () => {
    expect(mapSortParams('name', 'asc')).toBe('name-asc');
  });

  it('should map name+desc to name-desc', () => {
    expect(mapSortParams('name', 'desc')).toBe('name-desc');
  });

  it('should map updated to date-asc by default', () => {
    expect(mapSortParams('updated', 'asc')).toBe('date-asc');
  });

  it('should map created+desc to date-desc', () => {
    expect(mapSortParams('created', 'desc')).toBe('date-desc');
  });

  it('should default to name-asc with no arguments', () => {
    expect(mapSortParams()).toBe('name-asc');
  });

  it('should pass through unknown sort fields', () => {
    expect(mapSortParams('custom', 'desc')).toBe('custom-desc');
  });
});

describe('Log level parsing', () => {
  /**
   * Extracted parseMinLevel logic — mirrors src/web/public/logs.js.
   */
  function parseMinLevel(levelParam: string): string | null {
    const levelOrder = ['debug', 'info', 'warn', 'error'];
    const levels = levelParam.split(',')
      .map(l => l.trim().toLowerCase())
      .filter(l => levelOrder.includes(l));
    if (levels.length === 0) return null;
    return levels.reduce((min, l) =>
      levelOrder.indexOf(l) < levelOrder.indexOf(min) ? l : min
    , levels[0]);
  }

  it('should return single level as-is', () => {
    expect(parseMinLevel('error')).toBe('error');
  });

  it('should return minimum level from comma-separated list', () => {
    expect(parseMinLevel('error,warn')).toBe('warn');
  });

  it('should handle all levels and pick the lowest', () => {
    expect(parseMinLevel('error,warn,info,debug')).toBe('debug');
  });

  it('should be case-insensitive', () => {
    expect(parseMinLevel('ERROR,WARN')).toBe('warn');
  });

  it('should handle whitespace', () => {
    expect(parseMinLevel('error , warn')).toBe('warn');
  });

  it('should return null for invalid levels', () => {
    expect(parseMinLevel('invalid')).toBeNull();
    expect(parseMinLevel('bogus,nonsense')).toBeNull();
  });

  it('should ignore invalid levels mixed with valid ones', () => {
    expect(parseMinLevel('error,bogus,info')).toBe('info');
  });

  it('should return null for empty string', () => {
    expect(parseMinLevel('')).toBeNull();
  });
});

describe('Server-side URL param extraction', () => {
  /**
   * Extracted extractUrlParams logic — mirrors MCPAQLHandler.extractUrlParams.
   */
  function extractUrlParams(params: Record<string, unknown>): Record<string, string> | undefined {
    const urlParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === 'tab' || value === undefined || value === null || value === '') continue;
      urlParams[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return Object.keys(urlParams).length > 0 ? urlParams : undefined;
  }

  it('should extract string params', () => {
    const result = extractUrlParams({ tab: 'logs', level: 'error', since: '1h' });
    expect(result).toEqual({ level: 'error', since: '1h' });
  });

  it('should exclude tab param', () => {
    const result = extractUrlParams({ tab: 'portfolio', q: 'test' });
    expect(result).toEqual({ q: 'test' });
  });

  it('should return undefined when only tab present', () => {
    const result = extractUrlParams({ tab: 'logs' });
    expect(result).toBeUndefined();
  });

  it('should return undefined for empty params', () => {
    const result = extractUrlParams({});
    expect(result).toBeUndefined();
  });

  it('should skip null and undefined values', () => {
    const result = extractUrlParams({ q: 'test', empty: null, missing: undefined, blank: '' });
    expect(result).toEqual({ q: 'test' });
  });

  it('should serialize objects as JSON', () => {
    const result = extractUrlParams({ filters: { tags: ['a', 'b'] } });
    expect(result).toEqual({ filters: '{"tags":["a","b"]}' });
  });

  it('should serialize numbers and booleans as strings', () => {
    const result = extractUrlParams({ page: 2, active: true });
    expect(result).toEqual({ page: '2', active: 'true' });
  });
});
