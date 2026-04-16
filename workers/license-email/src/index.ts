/**
 * DollhouseMCP License Email Worker
 *
 * Receives PostHog webhook events for `license_activation` and sends
 * confirmation emails. It also accepts direct verification-email requests
 * from the local setup server on a separate public endpoint with cooldowns
 * and rate limits.
 *
 * Setup:
 *   1. Deploy: `wrangler deploy`
 *   2. Set secret: `wrangler secret put POSTHOG_WEBHOOK_SECRET`
 *   3. In PostHog → Data pipelines → New destination → Webhook:
 *      - URL: https://dollhousemcp-license-email.<your-account>.workers.dev
 *      - Headers: { "x-posthog-secret": "<your-secret>" }
 *      - Filter: event_name = "license_activation"
 *
 * Email sending uses the MailChannels API which is available to all
 * Cloudflare Workers. Requires DNS TXT record for SPF:
 *   dollhousemcp.com TXT "v=spf1 include:_spf.mx.cloudflare.net include:relay.mailchannels.net ~all"
 *
 * Direct verification requests should target:
 *   https://dollhousemcp-license-email.<your-account>.workers.dev/direct-verification
 *
 * If MailChannels is unavailable, swap sendEmail() for Resend, SendGrid,
 * or any HTTP-based email API.
 */

interface Env {
  FROM_EMAIL: string;
  FROM_NAME: string;
  REPLY_TO: string;
  POSTHOG_WEBHOOK_SECRET?: string;
  RESEND_API_KEY: string;
}

interface PostHogEvent {
  event: string;
  distinct_id: string;
  properties: {
    tier: 'free-commercial' | 'paid-commercial';
    email: string;
    event_type?: 'verification' | 'activation';
    verification_code?: string;
    server_version?: string;
    os?: string;
    revenue_scale?: string;
    company_name?: string;
    use_case?: string;
  };
  timestamp?: string;
}

const DIRECT_VERIFICATION_PATH = '/direct-verification';
const DIRECT_IP_WINDOW_SECONDS = 60;
const DIRECT_IP_MAX_REQUESTS = 5;
const DIRECT_EMAIL_COOLDOWN_SECONDS = 60;
const DIRECT_STORE_PREFIX = 'https://dollhouse-cache.local/license-email/';
const VERIFICATION_CODE_PATTERN = /^\d{6}$/;
const memoryStore = new Map<string, { value: string; expiresAt: number }>();

interface AbuseStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

function makeStoreRequest(key: string): Request {
  return new Request(`${DIRECT_STORE_PREFIX}${key}`);
}

function getAbuseStore(): AbuseStore {
  const cacheApi = globalThis.caches?.default;
  if (cacheApi && typeof cacheApi.match === 'function' && typeof cacheApi.put === 'function') {
    return {
      async get(key: string): Promise<string | null> {
        const response = await cacheApi.match(makeStoreRequest(key));
        return response ? response.text() : null;
      },
      async put(key: string, value: string, ttlSeconds: number): Promise<void> {
        await cacheApi.put(
          makeStoreRequest(key),
          new Response(value, {
            headers: {
              'Cache-Control': `max-age=${ttlSeconds}`,
            },
          }),
        );
      },
    };
  }

  return {
    async get(key: string): Promise<string | null> {
      const entry = memoryStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        memoryStore.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, ttlSeconds: number): Promise<void> {
      memoryStore.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    },
  };
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidEmailAddress(value: unknown): boolean {
  const email = normalizeEmail(value);
  if (email.length < 3 || email.length > 254) return false;
  if (email.includes(' ') || email.startsWith('@') || email.endsWith('@')) return false;

  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return false;

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (!localPart || !domain) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;

  const domainLabels = domain.split('.');
  if (domainLabels.length < 2) return false;
  if (domainLabels.some(label => label.length === 0)) return false;

  return true;
}

function getClientIp(request: Request): string {
  const header = request.headers.get('CF-Connecting-IP');
  return header?.trim() || 'unknown';
}

function parseIpWindowCounter(raw: string | null): { count: number; resetAt: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { count?: number; resetAt?: number };
    if (typeof parsed.count !== 'number' || typeof parsed.resetAt !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validateDirectVerificationEvent(event: PostHogEvent): string | null {
  if (event.event !== 'license_activation') {
    return 'Direct verification endpoint only accepts license_activation events.';
  }

  const { tier, email, event_type, verification_code } = event.properties ?? {};
  if (tier !== 'free-commercial' && tier !== 'paid-commercial') {
    return 'Missing required fields: tier, email';
  }
  if (!isValidEmailAddress(email)) {
    return 'Missing required fields: tier, email';
  }
  if (event_type !== 'verification') {
    return 'Direct verification endpoint only accepts verification events.';
  }
  if (!VERIFICATION_CODE_PATTERN.test(typeof verification_code === 'string' ? verification_code : '')) {
    return 'Missing required verification_code for verification event';
  }
  return null;
}

async function enforceDirectVerificationLimits(request: Request, email: string): Promise<Response | null> {
  const store = getAbuseStore();
  const normalizedEmail = normalizeEmail(email);
  const emailKey = `email:${encodeURIComponent(normalizedEmail)}`;
  if (await store.get(emailKey)) {
    return new Response('Please wait before requesting another verification email.', { status: 429 });
  }

  const ip = getClientIp(request);
  const ipKey = `ip:${encodeURIComponent(ip)}`;
  const now = Date.now();
  const existingWindow = parseIpWindowCounter(await store.get(ipKey));
  const windowCounter = existingWindow && existingWindow.resetAt > now
    ? existingWindow
    : { count: 0, resetAt: now + DIRECT_IP_WINDOW_SECONDS * 1000 };

  if (windowCounter.count >= DIRECT_IP_MAX_REQUESTS) {
    return new Response('Too many verification requests. Please try again later.', { status: 429 });
  }

  windowCounter.count += 1;
  const remainingWindowSeconds = Math.max(1, Math.ceil((windowCounter.resetAt - now) / 1000));
  await Promise.all([
    store.put(ipKey, JSON.stringify(windowCounter), remainingWindowSeconds),
    store.put(emailKey, '1', DIRECT_EMAIL_COOLDOWN_SECONDS),
  ]);

  return null;
}

/** Handle verification event: send verification code email. */
async function handleVerification(props: PostHogEvent['properties'], env: Env): Promise<void> {
  if (!props.verification_code) {
    throw new Error('Missing verification_code for verification event');
  }
  const verificationEmail = buildVerificationEmail(props, env);
  await sendEmail({
    from: { name: env.FROM_NAME, email: env.FROM_EMAIL },
    to: props.email,
    replyTo: env.REPLY_TO,
    subject: verificationEmail.subject,
    html: verificationEmail.html,
    env,
  });
}

/** Handle activation event: send confirmation email (+ sales notification for Enterprise). */
async function handleActivation(props: PostHogEvent['properties'], env: Env): Promise<void> {
  const { subject, html } = props.tier === 'paid-commercial'
    ? buildEnterpriseEmail(props, env)
    : buildCommercialEmail(props, env);

  await sendEmail({
    from: { name: env.FROM_NAME, email: env.FROM_EMAIL },
    to: props.email,
    replyTo: env.REPLY_TO,
    subject,
    html,
    env,
  });

  if (props.tier === 'paid-commercial') {
    const salesNotification = buildSalesNotification(props);
    await sendEmail({
      from: { name: env.FROM_NAME, email: env.FROM_EMAIL },
      to: env.REPLY_TO,
      replyTo: props.email,
      subject: salesNotification.subject,
      html: salesNotification.html,
      env,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    let event: PostHogEvent;
    try {
      event = await request.json() as PostHogEvent;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (url.pathname === DIRECT_VERIFICATION_PATH) {
      const validationError = validateDirectVerificationEvent(event);
      if (validationError) {
        return new Response(validationError, { status: 400 });
      }

      const rateLimitResponse = await enforceDirectVerificationLimits(request, event.properties.email);
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      try {
        await handleVerification(event.properties, env);
        return new Response(JSON.stringify({
          success: true,
          tier: event.properties.tier,
          email: event.properties.email,
          event_type: 'verification',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error(`License email worker error: ${getSafeErrorMessage(error)}`);
        return new Response(JSON.stringify({ error: 'Email delivery failed', success: false }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (env.POSTHOG_WEBHOOK_SECRET) {
      const secret = request.headers.get('x-posthog-secret');
      if (secret !== env.POSTHOG_WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    if (event.event !== 'license_activation') {
      return new Response('Ignored: not a license_activation event', { status: 200 });
    }

    const { tier, email, event_type } = event.properties;
    if (!email || !tier) {
      return new Response('Missing required fields: tier, email', { status: 400 });
    }

    try {
      if (event_type === 'verification') {
        await handleVerification(event.properties, env);
      } else {
        await handleActivation(event.properties, env);
      }

      return new Response(JSON.stringify({ success: true, tier, email, event_type: event_type ?? 'activation' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error(`License email worker error: ${getSafeErrorMessage(error)}`);
      return new Response(JSON.stringify({ error: 'Email delivery failed', success: false }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

// ── HTML escaping ────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS in email templates. */
function esc(str: string | undefined | null): string {
  if (!str) return '';
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ── Email templates ──────────────────────────────────────────────────

function buildVerificationEmail(
  props: PostHogEvent['properties'],
  env: Env,
): { subject: string; html: string } {
  const code = esc(props.verification_code);
  const verifyUrl = `http://dollhouse.localhost:41715#verify=${code}`;
  return {
    subject: `DollhouseMCP — Verify your email to activate your license`,
    html: `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e;">Verify your email address</h2>
  <p>You're registering a <strong>${esc(props.tier === 'paid-commercial' ? 'Enterprise' : 'Commercial')}</strong> license for DollhouseMCP.</p>

  <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin: 24px 0;">
    <p style="margin: 0 0 12px; font-size: 15px; font-weight: 600; color: #1e40af; text-align: center;">On the same computer where DollhouseMCP is installed?</p>
    <div style="text-align: center;">
      <a href="${verifyUrl}" style="display: inline-block; background: #3b82f6; color: #ffffff; font-weight: 600; font-size: 16px; padding: 14px 32px; border-radius: 8px; text-decoration: none;">Verify my email</a>
    </div>
    <p style="color: #64748b; font-size: 13px; margin: 10px 0 0; text-align: center;">This button opens your DollhouseMCP console and verifies automatically.</p>
  </div>

  <div style="background: #fefce8; border: 1px solid #fde68a; border-radius: 8px; padding: 20px; margin: 24px 0;">
    <p style="margin: 0 0 12px; font-size: 15px; font-weight: 600; color: #92400e; text-align: center;">Reading this on your phone or another device?</p>
    <p style="margin: 0 0 12px; font-size: 14px; color: #78716c; text-align: center;">Copy this code and paste it into the Setup page on your computer:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background: #ffffff; border: 2px solid #e2e8f0; border-radius: 12px; padding: 16px 32px; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #1a1a2e; font-family: 'Courier New', Courier, monospace; white-space: nowrap;">${code}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <p style="margin: 10px 0 0; font-size: 13px; color: #78716c; text-align: center;">Long-press the code to copy it, then paste on the Setup page</p>
  </div>

  <p style="color: #64748b; font-size: 13px;">This link and code expire in 10 minutes. If you didn't request this, you can safely ignore this email.</p>

  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
  <p style="font-size: 12px; color: #64748b;">DollhouseMCP &mdash; AI customization through modular elements<br>
  <a href="https://github.com/DollhouseMCP/mcp-server" style="color: #3b82f6;">github.com/DollhouseMCP/mcp-server</a></p>
</body></html>`,
  };
}

function buildCommercialEmail(
  props: PostHogEvent['properties'],
  env: Env,
): { subject: string; html: string } {
  return {
    subject: 'DollhouseMCP — Free Commercial License Confirmation',
    html: `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e;">Your DollhouseMCP Commercial License</h2>
  <p>Thank you for choosing the <strong>Free Commercial</strong> license for DollhouseMCP.</p>

  <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px; font-weight: 600;">License terms:</p>
    <ul style="margin: 0; padding-left: 20px;">
      <li>Organization annual revenue under $1,000,000 USD</li>
      <li>Attribution required in commercial products using DollhouseMCP</li>
      <li>Anonymous usage telemetry enabled</li>
    </ul>
  </div>

  <p><strong>License ID:</strong> <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${esc(props.email)}-commercial-${new Date().toISOString().slice(0, 10)}</code></p>
  <p><strong>Activated:</strong> ${new Date().toUTCString()}</p>
  <p><strong>Server version:</strong> ${esc(props.server_version)}</p>

  <p>This license is valid as long as your organization meets the revenue threshold. If your revenue exceeds $1M USD, please upgrade to an Enterprise license.</p>

  <p>Questions? Reply to this email or contact <a href="mailto:${env.REPLY_TO}">${env.REPLY_TO}</a>.</p>

  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
  <p style="font-size: 12px; color: #64748b;">DollhouseMCP &mdash; AI customization through modular elements<br>
  <a href="https://github.com/DollhouseMCP/mcp-server" style="color: #3b82f6;">github.com/DollhouseMCP/mcp-server</a></p>
</body></html>`,
  };
}

function buildEnterpriseEmail(
  props: PostHogEvent['properties'],
  env: Env,
): { subject: string; html: string } {
  return {
    subject: 'DollhouseMCP — Enterprise License Inquiry Received',
    html: `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e;">Enterprise License Inquiry Received</h2>
  <p>Thank you for your interest in the <strong>DollhouseMCP Enterprise</strong> license.</p>

  <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0 0 8px; font-weight: 600;">Your inquiry details:</p>
    <ul style="margin: 0; padding-left: 20px;">
      <li><strong>Company:</strong> ${esc(props.company_name) || 'Not provided'}</li>
      <li><strong>Revenue scale:</strong> ${esc(props.revenue_scale) || 'Not provided'}</li>
      <li><strong>Use case:</strong> ${esc(props.use_case) || 'Not provided'}</li>
    </ul>
  </div>

  <p>Our team will review your inquiry and reach out within <strong>2 business days</strong> to discuss licensing options, including:</p>
  <ul>
    <li>White-label and custom branding</li>
    <li>Priority support and SLA agreements</li>
    <li>Volume licensing</li>
  </ul>

  <p>In the meantime, DollhouseMCP continues to work under the default AGPL-3.0 license.</p>

  <p>Questions? Reply to this email or contact <a href="mailto:${env.REPLY_TO}">${env.REPLY_TO}</a>.</p>

  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
  <p style="font-size: 12px; color: #64748b;">DollhouseMCP &mdash; AI customization through modular elements<br>
  <a href="https://github.com/DollhouseMCP/mcp-server" style="color: #3b82f6;">github.com/DollhouseMCP/mcp-server</a></p>
</body></html>`,
  };
}

function buildSalesNotification(
  props: PostHogEvent['properties'],
): { subject: string; html: string } {
  return {
    subject: `[Enterprise Inquiry] ${(props.company_name ?? props.email).replaceAll('<', '').replaceAll('>', '').replaceAll('"', '')} — ${(props.revenue_scale ?? 'unknown scale').replaceAll('<', '').replaceAll('>', '').replaceAll('"', '')}`,
    html: `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2>New Enterprise License Inquiry</h2>

  <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Email</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;"><a href="mailto:${esc(props.email)}">${esc(props.email)}</a></td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Company</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${esc(props.company_name) || '—'}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Revenue Scale</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${esc(props.revenue_scale) || '—'}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Use Case</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${esc(props.use_case) || '—'}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Server Version</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${esc(props.server_version) || '—'}</td></tr>
    <tr><td style="padding: 8px; font-weight: 600;">OS</td><td style="padding: 8px;">${esc(props.os) || '—'}</td></tr>
  </table>

  <p style="margin-top: 16px;">Reply directly to this email to respond to the customer.</p>
</body></html>`,
  };
}

// ── Resend API ───────────────────────────────────────────────────────

interface EmailParams {
  from: { name: string; email: string };
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  env: Env;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

async function sendEmail(params: EmailParams): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${params.from.name} <${params.from.email}>`,
        to: [params.to],
        reply_to: params.replyTo,
        subject: params.subject,
        html: params.html,
      }),
    });

    if (response.ok) return;

    await response.text();
    console.error(`Resend API error (attempt ${attempt + 1}/${MAX_RETRIES + 1}, status ${response.status})`);

    // Don't retry on client errors (400, 401, 403, 422) — only server/rate errors
    if (response.status < 500 && response.status !== 429) {
      throw new Error('Email delivery failed');
    }

    lastError = new Error('Email delivery failed');
  }

  throw lastError ?? new Error('Email delivery failed');
}
