import { randomBytes } from 'node:crypto';
import express, { type Router } from 'express';
import { buildContentSecurityPolicy } from '../../auth/embedded-as/securityHeaders.js';
import { ROLE_DESCRIPTIONS } from '../../web-console/modules/account-admin/AccountAdminRoleDescriptions.js';
import { INVITATION_CLAIM_PATH } from '../InvitationClaimLink.js';
import { normalizeInvitationEmail } from '../InvitationEmail.js';
import { MAX_INVITATION_TOKEN_LENGTH } from '../InvitationToken.js';
import { startOnboardingClaimPage } from './OnboardingClaimClient.js';

/** Static, unregistered shell only. No cookies, credential consumption, or ordinary authentication on GET. */
export function createOnboardingClaimPageRouter(supportEmail: string): Router {
  const normalized = normalizeInvitationEmail(supportEmail);
  const original = supportEmail.normalize('NFC').trim();
  const support = original.slice(0, original.indexOf('@')) + normalized.slice(normalized.indexOf('@'));
  const [local, domain] = support.split('@');
  const href = `mailto:${encodeURIComponent(local)}@${encodeURIComponent(domain)}`;
  const router = express.Router();
  router.get(INVITATION_CLAIM_PATH, (req, res) => {
    const nonce = randomBytes(16).toString('base64url');
    res.set({ 'Content-Security-Policy': buildContentSecurityPolicy(nonce).replace("script-src 'none'", `script-src 'nonce-${nonce}'`),
      'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url.includes('?')) { res.status(400).end('Invitation request unavailable'); return; }
    const config = JSON.stringify({ claimPath: INVITATION_CLAIM_PATH, maxTokenLength: MAX_INVITATION_TOKEN_LENGTH, roles: ROLE_DESCRIPTIONS })
      .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    // End directly: a parent AS securityHeaders() wrapper resets CSP inside res.send.
    // This exact route owns the final nonce policy; every other auth/API route stays script-none.
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your DollhouseMCP invitation</title><style nonce="${nonce}">
:root{font-family:system-ui,sans-serif;color:#202333;background:#f5f5fa;line-height:1.6}*{box-sizing:border-box}body{margin:0;padding:clamp(1rem,5vw,3rem)}main{max-width:42rem;margin:auto;background:white;padding:clamp(1.2rem,5vw,3rem);border:1px solid #d9dce7;border-radius:1rem}h1{line-height:1.2;font-size:clamp(1.7rem,6vw,2.4rem)}h2{font-size:1.3rem}button,a{font:inherit}button{padding:.7rem 1.1rem;border:1px solid #403080;border-radius:.4rem;background:#493294;color:white;cursor:pointer}button:disabled{background:#e8e7ed;color:#52515b;border-color:#bbb;cursor:default}:focus-visible{outline:3px solid #156bbb;outline-offset:3px}a{color:#423089}dt{font-weight:650}dd{margin:0 0 .7rem;overflow-wrap:anywhere}li{margin:.6rem 0}[hidden]{display:none!important}.eyebrow{color:#625779;font-weight:600}.notice{border-left:3px solid #7255b4;padding-left:1rem}footer{margin-top:2rem;font-size:.95rem}#claim-status{min-height:3rem}#claim-status:focus{outline:none}
</style></head><body><main><p class="eyebrow">DollhouseMCP · Invite-only beta</p><h1>Your invitation</h1>
<p>DollhouseMCP gives AI assistants access to the personas, skills, and other elements you choose.</p>
<p>A GitHub account is required to activate your account. You will not create a separate DollhouseMCP password.</p>
<p id="claim-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">Preparing your invitation…</p>
<button id="claim-continue" type="button" disabled>Continue</button><button id="claim-retry" type="button" hidden>Try again</button>
<section id="claim-details" hidden aria-labelledby="claim-review"><h2 id="claim-review">Review your invitation</h2><dl>
<dt>Name</dt><dd id="claim-name"></dd><dt>Username</dt><dd id="claim-username"></dd><dt>Verified email</dt><dd id="claim-email"></dd>
<dt>Invitation expires</dt><dd><span id="claim-expiry"></span><br><span id="claim-relative"></span></dd></dl><h2>Intended access</h2><ul id="claim-roles"></ul>
<p>Your GitHub account ID and public profile identify your login. Connecting a GitHub portfolio or integration is a separate, optional step.</p>
<p class="notice">GitHub connection is currently unavailable. Your account has not been activated.</p><button type="button" disabled>Continue with GitHub</button></section>
<p><button id="claim-logout" type="button" hidden>Sign out of onboarding</button></p>
<noscript><p>JavaScript is required to read your private invitation link. Enable it and reopen the link from your email. No invitation has been consumed.</p></noscript>
<footer>Need help or a new invitation? <a href="${escapeHtml(href)}">Contact ${escapeHtml(support)}</a>.</footer>
</main><script nonce="${nonce}">(${startOnboardingClaimPage.toString()})(${config});</script></body></html>`);
  });
  return router;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
