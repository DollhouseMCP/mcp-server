/**
 * Unit tests for the DollhouseMCP License Email Worker.
 *
 * The Worker (workers/license-email/src/index.ts) is a Cloudflare Worker that
 * receives PostHog webhook events and sends confirmation emails via Resend.
 * Since the Worker's internal functions aren't exported, we test the default
 * export's fetch() handler by providing mock Request objects and an Env.
 *
 * Strategy:
 *   - Import the Worker's default export directly
 *   - Call worker.fetch(request, env) with crafted Request + Env objects
 *   - Mock global fetch() to intercept Resend API calls
 *   - Assert on HTTP status, response body, and email HTML content
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// The Worker exports a default object with a fetch method.
// TypeScript needs the path to resolve; Jest will handle the TS transform.
import worker from '../../../workers/license-email/src/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────

interface Env {
  FROM_EMAIL: string;
  FROM_NAME: string;
  REPLY_TO: string;
  POSTHOG_WEBHOOK_SECRET?: string;
  RESEND_API_KEY: string;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    FROM_EMAIL: 'noreply@dollhousemcp.com',
    FROM_NAME: 'DollhouseMCP',
    REPLY_TO: 'sales@dollhousemcp.com',
    POSTHOG_WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 'test-resend-key',
    ...overrides,
  };
}

function makeRequest(
  body: unknown,
  options: {
    method?: string;
    secret?: string | null;
    invalidJson?: boolean;
    path?: string;
    ip?: string;
  } = {},
): Request {
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options.secret !== null) {
    headers['x-posthog-secret'] = options.secret ?? 'test-secret';
  }
  if (options.ip) {
    headers['CF-Connecting-IP'] = options.ip;
  }

  if (options.invalidJson) {
    return new Request(`https://worker.example.com${options.path ?? '/'}`, {
      method,
      headers,
      body: 'not-json{{{',
    });
  }

  return new Request(`https://worker.example.com${options.path ?? '/'}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

function makeCommercialEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: 'license_activation',
    distinct_id: 'user-123',
    properties: {
      tier: 'free-commercial',
      email: 'customer@example.com',
      server_version: '2.0.10',
      os: 'darwin',
      ...overrides,
    },
  };
}

function makeEnterpriseEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: 'license_activation',
    distinct_id: 'user-456',
    properties: {
      tier: 'paid-commercial',
      email: 'enterprise@bigcorp.com',
      server_version: '2.0.10',
      os: 'linux',
      company_name: 'BigCorp Inc',
      revenue_scale: '$1M-$10M',
      use_case: 'Internal AI assistant',
      ...overrides,
    },
  };
}

// Capture the HTML bodies sent to Resend so we can assert on template content.
let capturedEmails: Array<{
  to: string[];
  subject: string;
  html: string;
  from: string;
  reply_to: string;
}>;

const originalFetch = globalThis.fetch;

function installFetchMock(responseOverride?: { ok: boolean; status: number; text: string }) {
  capturedEmails = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
    }
    if (url === 'https://api.resend.com/emails') {
      const body = JSON.parse(init?.body as string);
      capturedEmails.push(body);
      if (responseOverride) {
        return new Response(responseOverride.text, {
          status: responseOverride.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'email-id-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init as any);
  }) as typeof globalThis.fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('License Email Worker', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    restoreFetch();
  });

  // ── 1. Email Template Content Tests ─────────────────────────────────

  describe('Email Template Content', () => {
    describe('Commercial (free-commercial) email', () => {
      it('contains "Free Commercial" license text', async () => {
        const env = makeEnv();
        const req = makeRequest(makeCommercialEvent());
        await worker.fetch(req, env);

        expect(capturedEmails).toHaveLength(1);
        expect(capturedEmails[0].html).toContain('Free Commercial');
      });

      it('contains the customer email as a license ID component', async () => {
        const env = makeEnv();
        const req = makeRequest(makeCommercialEvent({ email: 'alice@widgets.co' }));
        await worker.fetch(req, env);

        expect(capturedEmails[0].html).toContain('alice@widgets.co');
        // License ID format: <email>-commercial-<date>
        expect(capturedEmails[0].html).toMatch(/alice@widgets\.co-commercial-\d{4}-\d{2}-\d{2}/);
      });

      it('contains the server version', async () => {
        const env = makeEnv();
        const req = makeRequest(makeCommercialEvent({ server_version: '2.0.10' }));
        await worker.fetch(req, env);

        expect(capturedEmails[0].html).toContain('2.0.10');
      });

      it('contains sales@dollhousemcp.com contact link', async () => {
        const env = makeEnv({ REPLY_TO: 'sales@dollhousemcp.com' });
        const req = makeRequest(makeCommercialEvent());
        await worker.fetch(req, env);

        expect(capturedEmails[0].html).toContain('mailto:sales@dollhousemcp.com');
        expect(capturedEmails[0].html).toContain('sales@dollhousemcp.com');
      });
    });

    describe('Enterprise (paid-commercial) email', () => {
      it('contains company name, revenue scale, and use case', async () => {
        const env = makeEnv();
        const req = makeRequest(makeEnterpriseEvent());
        await worker.fetch(req, env);

        // First email is the enterprise confirmation to the customer
        const customerEmail = capturedEmails[0];
        expect(customerEmail.html).toContain('BigCorp Inc');
        expect(customerEmail.html).toContain('$1M-$10M');
        expect(customerEmail.html).toContain('Internal AI assistant');
      });

      it('mentions "2 business days" response time', async () => {
        const env = makeEnv();
        const req = makeRequest(makeEnterpriseEvent());
        await worker.fetch(req, env);

        expect(capturedEmails[0].html).toContain('2 business days');
      });

      it('lists white-label, priority support, and volume licensing', async () => {
        const env = makeEnv();
        const req = makeRequest(makeEnterpriseEvent());
        await worker.fetch(req, env);

        const html = capturedEmails[0].html;
        expect(html).toContain('White-label');
        expect(html).toContain('Priority support');
        expect(html).toContain('Volume licensing');
      });
    });

    describe('Sales notification email', () => {
      it('contains all customer details in a table', async () => {
        const env = makeEnv();
        const req = makeRequest(makeEnterpriseEvent());
        await worker.fetch(req, env);

        // Second email is the sales notification
        expect(capturedEmails).toHaveLength(2);
        const salesEmail = capturedEmails[1];
        expect(salesEmail.html).toContain('<table');
        expect(salesEmail.html).toContain('enterprise@bigcorp.com');
        expect(salesEmail.html).toContain('BigCorp Inc');
        expect(salesEmail.html).toContain('$1M-$10M');
        expect(salesEmail.html).toContain('Internal AI assistant');
        expect(salesEmail.html).toContain('2.0.10');
      });

      it('subject includes company name and revenue scale', async () => {
        const env = makeEnv();
        const req = makeRequest(makeEnterpriseEvent());
        await worker.fetch(req, env);

        const salesEmail = capturedEmails[1];
        expect(salesEmail.subject).toContain('BigCorp Inc');
        expect(salesEmail.subject).toContain('$1M-$10M');
      });
    });

    describe('HTML structure', () => {
      it('commercial email has proper HTML structure', async () => {
        const env = makeEnv();
        const req = makeRequest(makeCommercialEvent());
        await worker.fetch(req, env);

        const html = capturedEmails[0].html;
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('<body');
        expect(html).toContain('</body>');
        expect(html).toContain('</html>');
      });

      it('enterprise email has proper HTML structure', async () => {
        const env = makeEnv();
        const req = makeRequest(makeEnterpriseEvent());
        await worker.fetch(req, env);

        const html = capturedEmails[0].html;
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('<body');
        expect(html).toContain('</body>');
        expect(html).toContain('</html>');
      });

      it('sales notification has proper HTML structure', async () => {
        const env = makeEnv();
        const req = makeRequest(makeEnterpriseEvent());
        await worker.fetch(req, env);

        const html = capturedEmails[1].html;
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('<body');
        expect(html).toContain('</body>');
        expect(html).toContain('</html>');
      });
    });

    describe('XSS prevention', () => {
      it('does not execute script tags injected into company name', async () => {
        const env = makeEnv();
        const req = makeRequest(
          makeEnterpriseEvent({
            company_name: '<script>alert("xss")</script>',
          }),
        );
        await worker.fetch(req, env);

        const customerHtml = capturedEmails[0].html;
        const salesHtml = capturedEmails[1].html;

        // Verify the script tag is HTML-escaped, not rendered raw
        expect(customerHtml).not.toContain('<script>');
        expect(salesHtml).not.toContain('<script>');
        expect(customerHtml).toContain('&lt;script&gt;');
        expect(salesHtml).toContain('&lt;script&gt;');
      });
    });
  });

  // ── 2. Request Validation Tests ─────────────────────────────────────

  describe('Request Validation', () => {
    it('returns 401 when x-posthog-secret header is missing on the webhook endpoint', async () => {
      const env = makeEnv({ POSTHOG_WEBHOOK_SECRET: 'real-secret' });
      const req = makeRequest(makeCommercialEvent(), { secret: null });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
    });

    it('returns 401 when secret is wrong on the webhook endpoint', async () => {
      const env = makeEnv({ POSTHOG_WEBHOOK_SECRET: 'real-secret' });
      const req = makeRequest(makeCommercialEvent(), { secret: 'wrong-secret' });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
    });

    it('returns 405 for non-POST methods', async () => {
      const env = makeEnv();
      const req = new Request('https://worker.example.com/', {
        method: 'GET',
        headers: { 'x-posthog-secret': 'test-secret' },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(405);
    });

    it('returns 400 for invalid JSON body', async () => {
      const env = makeEnv();
      const req = makeRequest(null, { invalidJson: true });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
    });

    it('returns 200 (ignored) when event field is missing', async () => {
      const env = makeEnv();
      const req = makeRequest({ properties: { tier: 'free-commercial', email: 'a@b.com' } });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Ignored');
    });

    it('returns 200 (ignored) for non license_activation events', async () => {
      const env = makeEnv();
      const req = makeRequest({
        event: 'page_view',
        distinct_id: 'user-1',
        properties: { tier: 'free-commercial', email: 'a@b.com' },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Ignored');
    });

    it('returns 400 when email property is missing', async () => {
      const env = makeEnv();
      const req = makeRequest({
        event: 'license_activation',
        distinct_id: 'user-1',
        properties: { tier: 'free-commercial' },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
    });

    it('returns 400 when tier property is missing', async () => {
      const env = makeEnv();
      const req = makeRequest({
        event: 'license_activation',
        distinct_id: 'user-1',
        properties: { email: 'a@b.com' },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
    });

    it('processes valid free-commercial event successfully', async () => {
      const env = makeEnv();
      const req = makeRequest(makeCommercialEvent());

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; tier: string; email: string };
      expect(body.success).toBe(true);
      expect(body.tier).toBe('free-commercial');
      expect(body.email).toBe('customer@example.com');
      // Only one email sent for commercial tier (no sales notification)
      expect(capturedEmails).toHaveLength(1);
    });

    it('processes valid paid-commercial event successfully', async () => {
      const env = makeEnv();
      const req = makeRequest(makeEnterpriseEvent());

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; tier: string; email: string };
      expect(body.success).toBe(true);
      expect(body.tier).toBe('paid-commercial');
      expect(body.email).toBe('enterprise@bigcorp.com');
      // Two emails: customer confirmation + sales notification
      expect(capturedEmails).toHaveLength(2);
    });

    it('accepts direct verification requests without the webhook secret', async () => {
      const env = makeEnv({ POSTHOG_WEBHOOK_SECRET: 'real-secret' });
      const req = makeRequest(
        makeCommercialEvent({
          email: 'direct-success@example.com',
          event_type: 'verification',
          verification_code: '123456',
        }),
        { path: '/direct-verification', secret: null, ip: '203.0.113.10' },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as { success: boolean; event_type: string };
      expect(body.success).toBe(true);
      expect(body.event_type).toBe('verification');
      expect(capturedEmails).toHaveLength(1);
    });

    it('rejects direct requests without a verification code', async () => {
      const env = makeEnv();
      const req = makeRequest(
        makeCommercialEvent({
          email: 'direct-missing-code@example.com',
          event_type: 'verification',
        }),
        { path: '/direct-verification', secret: null, ip: '203.0.113.11' },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('verification_code');
    });

    it('rejects activation events on the direct verification endpoint', async () => {
      const env = makeEnv();
      const req = makeRequest(
        makeCommercialEvent({ email: 'direct-activation@example.com' }),
        { path: '/direct-verification', secret: null, ip: '203.0.113.12' },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('verification events');
    });

    it('rate limits repeated direct verification requests for the same email', async () => {
      const env = makeEnv();
      const firstReq = makeRequest(
        makeCommercialEvent({
          email: 'direct-repeat@example.com',
          event_type: 'verification',
          verification_code: '654321',
        }),
        { path: '/direct-verification', secret: null, ip: '203.0.113.13' },
      );

      const secondReq = makeRequest(
        makeCommercialEvent({
          email: 'direct-repeat@example.com',
          event_type: 'verification',
          verification_code: '654321',
        }),
        { path: '/direct-verification', secret: null, ip: '203.0.113.13' },
      );

      expect((await worker.fetch(firstReq, env)).status).toBe(200);

      const secondRes = await worker.fetch(secondReq, env);
      expect(secondRes.status).toBe(429);
      expect(await secondRes.text()).toContain('Please wait');
    });

    it('rate limits bursts from the same IP on the direct verification endpoint', async () => {
      const env = makeEnv();
      const ip = '203.0.113.14';

      for (let index = 0; index < 5; index += 1) {
        const req = makeRequest(
          makeCommercialEvent({
            email: `direct-ip-${index}@example.com`,
            event_type: 'verification',
            verification_code: '111111',
          }),
          { path: '/direct-verification', secret: null, ip },
        );
        expect((await worker.fetch(req, env)).status).toBe(200);
      }

      const blockedReq = makeRequest(
        makeCommercialEvent({
          email: 'direct-ip-blocked@example.com',
          event_type: 'verification',
          verification_code: '111111',
        }),
        { path: '/direct-verification', secret: null, ip },
      );

      const blockedRes = await worker.fetch(blockedReq, env);
      expect(blockedRes.status).toBe(429);
      expect(await blockedRes.text()).toContain('Too many verification requests');
    });
  });

  // ── 3. Error Handling Tests ─────────────────────────────────────────

  describe('Error Handling', () => {
    it('returns generic error when Resend API fails (no stack trace)', async () => {
      restoreFetch();
      installFetchMock({ ok: false, status: 500, text: 'Internal Resend Error: secret DB token xyz' });

      const env = makeEnv();
      const req = makeRequest(makeCommercialEvent());

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(500);

      const body = await res.json() as { error: string; success: boolean };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Email delivery failed');
    });

    it('error response does NOT contain internal error details', async () => {
      restoreFetch();
      installFetchMock({ ok: false, status: 500, text: 'Resend secret: sk_live_abc123' });

      const env = makeEnv();
      const req = makeRequest(makeCommercialEvent());

      const res = await worker.fetch(req, env);
      const text = JSON.stringify(await res.json());

      expect(text).not.toContain('sk_live_abc123');
      expect(text).not.toContain('Resend secret');
      expect(text).not.toContain('stack');
      expect(text).not.toContain('at ');
    });
  });
});
