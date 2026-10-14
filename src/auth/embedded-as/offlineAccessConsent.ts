import express, { type RequestHandler } from 'express';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';

/** Keep requested offline access through oidc-provider's check_scope consent filter. */
export function requireOfflineAccessConsent(params: URLSearchParams): void {
  // Validate only consent inputs without normalizing provider-owned values.
  for (const value of [...params.getAll('scope'), ...params.getAll('prompt')]) {
    if (!/^[\x20-\x7E]*$/.test(value) || UnicodeValidator.containsDangerousUnicode(value)) return;
  }
  // Signed request objects and pushed references remain entirely provider-owned.
  if (params.has('request') || params.has('request_uri')) return;
  // Preserve duplicates for the provider to reject, and never override prompt=none.
  if (params.getAll('scope').length !== 1 || params.getAll('prompt').length > 1) return;
  if (!params.get('scope')?.split(/\s+/).includes('offline_access')) return;
  const prompts = (params.get('prompt') ?? '').split(/\s+/).filter(Boolean);
  if (prompts.includes('none') || prompts.includes('consent')) return;
  params.set('prompt', [...prompts, 'consent'].join(' '));
}

/** Change only the raw prompt pair; unrelated bytes must survive even invalid UTF-8. */
function rewriteRawConsent(raw: string): string {
  const params = new URLSearchParams(raw);
  const originalPrompt = params.get('prompt');
  requireOfflineAccessConsent(params);
  const prompt = params.get('prompt');
  if (prompt === originalPrompt || prompt === null) return raw;
  if (originalPrompt === null) {
    const separator = raw.length === 0 || raw.endsWith('&') ? '' : '&';
    return raw + separator + 'prompt=consent';
  }
  const pairs = raw.split('&');
  const index = pairs.findIndex(pair => pair.startsWith('prompt='));
  // Encoded keys or a bare prompt cannot be replaced unambiguously.
  if (index === -1) return raw;
  pairs[index] = 'prompt=' + encodeURIComponent(prompt).replaceAll('%20', '+');
  return pairs.join('&');
}

/** Normalize only the authorization endpoint; approval and grant eligibility stay provider-owned. */
export function offlineAccessConsentHandlers(): RequestHandler[] {
  return [
    (req, _res, next) => {
      if (req.method === 'GET') {
        const queryStart = req.url.indexOf('?');
        if (queryStart !== -1) {
          req.url = req.url.slice(0, queryStart + 1) + rewriteRawConsent(req.url.slice(queryStart + 1));
        }
      }
      next();
    },
  ];
}

/** PAR uses the provider's parsed-body fallback, retaining duplicate parameters for validation. */
export function offlineAccessParConsentHandlers(): RequestHandler[] {
  const parse = express.text({ type: 'application/x-www-form-urlencoded', limit: '56kb' });
  // Map client errors from this parser only; server and downstream errors keep their own handlers.
  const parseBody: RequestHandler = (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (!error) { next(); return; }
      const status = typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) {
        next(error);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).json({ error: 'invalid_request', error_description: 'Unable to parse authorization request body.' });
    });
  };
  return [
    parseBody,
    (req, _res, next) => {
      if (typeof req.body === 'string') {
        req.body = rewriteRawConsent(req.body);
      }
      next();
    },
  ];
}
