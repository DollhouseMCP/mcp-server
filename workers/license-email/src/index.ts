/**
 * DollhouseMCP License Email Worker
 *
 * Receives PostHog webhook events for `license_activation` and sends
 * confirmation emails via MailChannels (Cloudflare's transactional email
 * partner — no additional account needed).
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
    server_version?: string;
    os?: string;
    revenue_scale?: string;
    company_name?: string;
    use_case?: string;
  };
  timestamp?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Validate PostHog webhook secret
    if (env.POSTHOG_WEBHOOK_SECRET) {
      const secret = request.headers.get('x-posthog-secret');
      if (secret !== env.POSTHOG_WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    let event: PostHogEvent;
    try {
      event = await request.json() as PostHogEvent;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (event.event !== 'license_activation') {
      return new Response('Ignored: not a license_activation event', { status: 200 });
    }

    const { tier, email } = event.properties;
    if (!email || !tier) {
      return new Response('Missing required fields: tier, email', { status: 400 });
    }

    const { subject, html } = tier === 'paid-commercial'
      ? buildEnterpriseEmail(event.properties, env)
      : buildCommercialEmail(event.properties, env);

    try {
      await sendEmail({
        from: { name: env.FROM_NAME, email: env.FROM_EMAIL },
        to: email,
        replyTo: env.REPLY_TO,
        subject,
        html,
        env,
      });

      // For Enterprise, also notify the sales team
      if (tier === 'paid-commercial') {
        const salesNotification = buildSalesNotification(event.properties);
        await sendEmail({
          from: { name: env.FROM_NAME, email: env.FROM_EMAIL },
          to: env.REPLY_TO,
          replyTo: email,
          subject: salesNotification.subject,
          html: salesNotification.html,
          env,
        });
      }

      return new Response(JSON.stringify({ success: true, tier, email }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

// ── Email templates ──────────────────────────────────────────────────

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

  <p><strong>License ID:</strong> <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${props.email}-commercial-${new Date().toISOString().slice(0, 10)}</code></p>
  <p><strong>Activated:</strong> ${new Date().toUTCString()}</p>
  <p><strong>Server version:</strong> ${props.server_version ?? 'unknown'}</p>

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
      <li><strong>Company:</strong> ${props.company_name ?? 'Not provided'}</li>
      <li><strong>Revenue scale:</strong> ${props.revenue_scale ?? 'Not provided'}</li>
      <li><strong>Use case:</strong> ${props.use_case ?? 'Not provided'}</li>
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
    subject: `[Enterprise Inquiry] ${props.company_name ?? props.email} — ${props.revenue_scale ?? 'unknown scale'}`,
    html: `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2>New Enterprise License Inquiry</h2>

  <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Email</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;"><a href="mailto:${props.email}">${props.email}</a></td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Company</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${props.company_name ?? '—'}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Revenue Scale</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${props.revenue_scale ?? '—'}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Use Case</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${props.use_case ?? '—'}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Server Version</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${props.server_version ?? '—'}</td></tr>
    <tr><td style="padding: 8px; font-weight: 600;">OS</td><td style="padding: 8px;">${props.os ?? '—'}</td></tr>
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

async function sendEmail(params: EmailParams): Promise<void> {
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend API error (${response.status}): ${text}`);
  }
}
