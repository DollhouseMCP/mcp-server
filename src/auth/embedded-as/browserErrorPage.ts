/**
 * Browser-facing auth error pages.
 *
 * Auth/login failures that reach a BROWSER navigation must render a clean HTML
 * page with a way back to sign-in — not raw problem JSON, which looks broken and
 * strands the user. Programmatic clients (XHR/fetch, MCP OAuth agents) still get
 * the JSON body. The AS CSP is `default-src 'none'; style-src 'unsafe-inline'`,
 * so the page uses inline styles + system fonts and NO scripts.
 */
import type { Request, Response } from 'express';

const DEFAULT_RETURN_HREF = '/api/v1/auth/login';

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True only on a positive HTML signal (a top-level document navigation), so
 * programmatic clients keep receiving JSON.
 */
export function requestPrefersHtml(req: Request): boolean {
  if (headerValue(req.headers['sec-fetch-dest']) === 'document') return true;
  const accept = headerValue(req.headers.accept) ?? '';
  if (accept.includes('application/json')) return false;
  return accept.includes('text/html');
}

/**
 * Content-negotiated auth error: HTML page for browser navigations, the original
 * `{ error, error_description }` JSON for everyone else (unchanged for API clients).
 */
export function sendAuthError(
  res: Response,
  req: Request,
  status: number,
  error: string,
  description: string,
  returnHref: string = DEFAULT_RETURN_HREF,
): void {
  if (requestPrefersHtml(req)) {
    res.status(status).type('text/html').send(renderAuthErrorPage(status, error, description, returnHref));
    return;
  }
  res.status(status).json({ error, error_description: description });
}

const FRIENDLY: Record<string, { title: string; message: string }> = {
  invalid_interaction: {
    title: 'Your sign-in session expired',
    message: 'This sign-in link expired or was already used. Please start signing in again.',
  },
  invalid_csrf: {
    title: 'We couldn’t verify that request',
    message: 'Your sign-in request couldn’t be verified — it may have expired or been opened in another tab. Please start again.',
  },
  access_denied: {
    title: 'Additional step required',
    message: 'This account can’t continue yet. If you’re setting up admin access, enroll an authenticator first.',
  },
  rate_limited: {
    title: 'Too many attempts',
    message: 'You’ve made too many attempts. Please wait a moment and try again.',
  },
  login_required: {
    title: 'Please sign in first',
    message: 'You need to sign in before continuing. Please sign in and try again.',
  },
  github_callback_failed: {
    title: 'GitHub sign-in didn’t complete',
    message: 'We couldn’t finish signing you in with GitHub. Please start sign-in again.',
  },
  invalid_capability: {
    title: 'That admin action isn’t available',
    message: 'This elevation request wasn’t valid. Return to the console and try again.',
  },
  bootstrap_required: {
    title: 'Setup isn’t finished',
    message: 'This server hasn’t finished its initial admin setup. Please contact your administrator.',
  },
  bootstrap_check_unavailable: {
    title: 'Service temporarily unavailable',
    message: 'We can’t verify the server’s setup right now. Please try again shortly.',
  },
  server_error: {
    title: 'Something went wrong',
    message: 'Something went wrong on our end while signing you in. Please try again.',
  },
};

export function renderAuthErrorPage(
  status: number,
  error: string,
  description: string,
  returnHref: string = DEFAULT_RETURN_HREF,
): string {
  const friendly = FRIENDLY[error] ?? {
    title: 'Sign-in problem',
    message: description || 'We couldn’t complete your sign-in. Please try again.',
  };
  const safeTitle = escapeHtml(friendly.title);
  const safeMessage = escapeHtml(friendly.message);
  const safeHref = escapeAttr(returnHref);
  const safeCode = escapeHtml(error);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} — ${safeTitle}</title>
<style>
  :root { --ink:#1f2430; --muted:#5b6473; --line:#e3e6ec; --accent:#1e40af; --bg:#f6f7f9; --card:#fff; }
  * { box-sizing: border-box; }
  html,body { height:100%; margin:0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--ink); display:flex; align-items:center; justify-content:center; padding:24px;
  }
  main {
    background: var(--card); border:1px solid var(--line); border-radius:14px;
    box-shadow: 0 10px 30px rgba(20,28,48,.06); max-width:460px; width:100%; padding:40px 36px; text-align:center;
  }
  .status { font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:600; }
  h1 { font-size:22px; line-height:1.25; margin:10px 0 12px; font-weight:700; }
  p { font-size:15px; line-height:1.6; color:var(--muted); margin:0 0 28px; }
  a.btn {
    display:inline-block; background:var(--accent); color:#fff; text-decoration:none;
    padding:11px 26px; border-radius:9px; font-weight:600; font-size:15px;
  }
  a.btn:hover { background:#1b3897; }
  .ref { margin-top:28px; padding-top:18px; border-top:1px solid var(--line); font-size:12px; color:#97a0b0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
  <main>
    <div class="status">Error ${status}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <a class="btn" href="${safeHref}">Return to sign in</a>
    <div class="ref">${safeCode}</div>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttr(value: string): string {
  // Only allow same-origin relative paths as the return target; anything else
  // falls back to the default login path (prevents open-redirect via the link).
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(value) ? escapeHtml(value) : DEFAULT_RETURN_HREF;
}
