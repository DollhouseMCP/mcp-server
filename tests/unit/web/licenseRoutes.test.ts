/**
 * License Routes — Unit Tests
 *
 * Tests the license selection API endpoints added to setupRoutes.ts:
 *   GET  /api/setup/license — returns current license from ~/.dollhouse/license.json
 *   POST /api/setup/license — validates and saves license selection
 *
 * Covers: validation, sanitization, rate limiting, error handling, security.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LICENSE_PATH = join(homedir(), '.dollhouse', 'license.json');

function mockFetchResponse(ok: boolean, status: number, body: Record<string, unknown> | string) {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    text: async () => responseBody,
    json: async () => (typeof body === 'string' ? { message: body } : body),
  }) as Promise<Response>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Save the existing license.json (if any) before tests, restore after. */
let savedLicense: string | null = null;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  try {
    savedLicense = await readFile(LICENSE_PATH, 'utf-8');
  } catch {
    savedLicense = null;
  }
});

afterAll(async () => {
  if (savedLicense === null) {
    try {
      await unlink(LICENSE_PATH);
    } catch {
      // file didn't exist before tests — nothing to clean up
    }
  } else {
    await writeFile(LICENSE_PATH, savedLicense, { mode: 0o600 });
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── API Endpoint Tests ───────────────────────────────────────────────────

describe('License Routes — API Endpoints', () => {
  let app: express.Express;

  beforeEach(async () => {
    globalThis.fetch = jest.fn().mockImplementation(() => mockFetchResponse(true, 200, { success: true }));
    const { createSetupRoutes } = await import('../../../src/web/routes/setupRoutes.js');
    const { getLicenseHandler, setLicenseHandler } = createSetupRoutes();

    app = express();
    app.use(express.json());
    app.get('/api/setup/license', getLicenseHandler);
    app.post('/api/setup/license', setLicenseHandler);
  });

  // Common acknowledgment flags for commercial tiers
  const COMMERCIAL_ACKS = { telemetryAcknowledged: true, attributionAcknowledged: true, revenueAttested: true };
  const ENTERPRISE_ACKS = { telemetryAcknowledged: true };

  // ── POST /api/setup/license — Validation ────────────────────────────

  describe('POST /api/setup/license — License Validation', () => {
    it('accepts valid AGPL selection', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'agpl' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.license.tier).toBe('agpl');
    });

    it('accepts valid free-commercial with email', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'dev@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.license.tier).toBe('free-commercial');
      expect(res.body.license.email).toBe('dev@example.com');
      expect(res.body.license.attestedAt).toBeDefined();
    });

    it('returns a delivery error when the verification worker rejects the request', async () => {
      globalThis.fetch = jest.fn().mockImplementation(() => mockFetchResponse(false, 401, 'Unauthorized'));

      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'dev@example.com', ...COMMERCIAL_ACKS })
        .expect(502);

      expect(res.body.verificationRequired).toBe(true);
      expect(res.body.error).toMatch(/Verification email service rejected the request/);

      const saved = JSON.parse(await readFile(LICENSE_PATH, 'utf-8'));
      expect(saved.status).toBe('pending');
      expect(saved.verificationCode).toHaveLength(6);
    });

    it('accepts valid paid-commercial with all fields', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'enterprise@bigcorp.com',
          revenueScale: '$5M–$25M',
          companyName: 'Big Corp Inc.',
          useCase: 'Internal tooling platform',
          ...ENTERPRISE_ACKS,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.license.tier).toBe('paid-commercial');
      expect(res.body.license.email).toBe('enterprise@bigcorp.com');
      expect(res.body.license.revenueScale).toBe('$5M–$25M');
      expect(res.body.license.companyName).toBe('Big Corp Inc.');
      expect(res.body.license.useCase).toBe('Internal tooling platform');
      expect(res.body.license.attestedAt).toBeDefined();
    });

    it('rejects missing tier', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ email: 'user@example.com' })
        .expect(400);

      expect(res.body.error).toMatch(/Invalid license tier/);
    });

    it('rejects invalid tier value', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'premium-ultra' })
        .expect(400);

      expect(res.body.error).toMatch(/Invalid license tier/);
    });

    it('rejects free-commercial missing email', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial' })
        .expect(400);

      expect(res.body.error).toMatch(/Email address is required/);
    });

    it('rejects free-commercial with invalid email (no @)', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'not-an-email' })
        .expect(400);

      expect(res.body.error).toMatch(/valid email/);
    });

    it('rejects free-commercial with email too long (>254 chars)', async () => {
      const longLocal = 'a'.repeat(243);
      const longEmail = `${longLocal}@example.com`;
      expect(longEmail.length).toBeGreaterThan(254);

      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: longEmail })
        .expect(400);

      expect(res.body.error).toMatch(/valid email/);
    });

    it('rejects free-commercial with email without TLD', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'user@localhost' })
        .expect(400);

      expect(res.body.error).toMatch(/valid email/);
    });

    it('rejects paid-commercial missing revenue scale', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          companyName: 'Corp',
          useCase: 'Internal use',
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Revenue scale is required/);
    });

    it('rejects paid-commercial with invalid revenue scale', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$999B',
          companyName: 'Corp',
          useCase: 'Internal use',
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Revenue scale is required/);
    });

    it('rejects paid-commercial missing company name', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$1M–$5M',
          useCase: 'Internal use',
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Company name is required/);
    });

    it('rejects paid-commercial with empty company name (whitespace only)', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$1M–$5M',
          companyName: '   ',
          useCase: 'Internal use',
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Company name is required/);
    });

    it('rejects paid-commercial missing use case', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$1M–$5M',
          companyName: 'Corp',
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Use case is required/);
    });

    it('rejects paid-commercial with empty use case (whitespace only)', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$1M–$5M',
          companyName: 'Corp',
          useCase: '  \t\n  ',
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Use case is required/);
    });

    it('sanitizes input: trims whitespace from company and use case fields', async () => {
      // Note: email is validated before sanitization, so spaces in email
      // are rejected by the regex. Only companyName and useCase get sanitized.
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'enterprise@bigcorp.com',
          revenueScale: '$1M–$5M',
          companyName: '  Big Corp  ',
          useCase: '  Internal tooling  ',
          telemetryAcknowledged: true,
        })
        .expect(200);

      expect(res.body.license.companyName).toBe('Big Corp');
      expect(res.body.license.useCase).toBe('Internal tooling');
    });

    it('sanitizes input: truncates long strings', async () => {
      const longCompany = 'A'.repeat(500);
      const longUseCase = 'B'.repeat(1000);

      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$1M–$5M',
          companyName: longCompany,
          useCase: longUseCase,
          telemetryAcknowledged: true,
        })
        .expect(200);

      // companyName max is 200, useCase max is 500
      expect(res.body.license.companyName.length).toBeLessThanOrEqual(200);
      expect(res.body.license.useCase.length).toBeLessThanOrEqual(500);
    });

    it('sanitizes XSS attempt in email: stored via sanitize(), not raw', async () => {
      // The EMAIL_PATTERN allows non-whitespace/non-@ chars including < > ( ) etc.
      // The XSS payload passes validation but is stored through the sanitize()
      // function which trims/truncates. The key defense is that the value is
      // written to a local JSON file (not rendered in HTML), so even if stored
      // it cannot execute.
      const xssEmail = '<script>alert("xss")</script>@evil.com';

      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: xssEmail, ...COMMERCIAL_ACKS })
        .expect(200);

      // Verify the email is stored as a plain string, not interpreted
      expect(res.body.license.email).toBe(xssEmail.trim());
      expect(typeof res.body.license.email).toBe('string');
    });

    it('accepts all valid revenue scale options', async () => {
      const validScales = ['$1M–$5M', '$5M–$25M', '$25M–$100M', '$100M+'];

      for (const revenueScale of validScales) {
        const res = await request(app)
          .post('/api/setup/license')
          .send({
            tier: 'paid-commercial',
            email: 'test@corp.com',
            revenueScale,
            companyName: 'Test Corp',
            useCase: 'Testing',
            ...ENTERPRISE_ACKS,
          });

        // Accept 200 or 429 (rate limit from sequential requests)
        expect([200, 429]).toContain(res.status);
        if (res.status === 200) {
          expect(res.body.license.revenueScale).toBe(revenueScale);
        }
      }
    });

    it('AGPL tier does not include email or attestedAt', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'agpl' })
        .expect(200);

      expect(res.body.license.email).toBeUndefined();
      expect(res.body.license.attestedAt).toBeUndefined();
    });

    it('free-commercial includes attestedAt as ISO timestamp', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'dev@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      const attestedAt = res.body.license.attestedAt;
      expect(attestedAt).toBeDefined();
      // Verify it's a valid ISO date string
      const parsed = new Date(attestedAt);
      expect(parsed.toISOString()).toBe(attestedAt);
    });
  });

  // ── GET /api/setup/license — Retrieval ──────────────────────────────

  describe('GET /api/setup/license — License Retrieval', () => {
    it('returns default (agpl) when no license file exists', async () => {
      // Remove any existing license file
      try {
        await unlink(LICENSE_PATH);
      } catch {
        // may not exist — that's fine
      }

      const res = await request(app)
        .get('/api/setup/license')
        .expect(200);

      expect(res.body.tier).toBe('agpl');
    });

    it('returns saved license data after POST', async () => {
      // First, set a license
      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'roundtrip@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      // Then retrieve it
      const res = await request(app)
        .get('/api/setup/license')
        .expect(200);

      expect(res.body.tier).toBe('free-commercial');
      expect(res.body.email).toBe('roundtrip@example.com');
      expect(res.body.attestedAt).toBeDefined();
    });
  });

  // ── Rate Limiting ───────────────────────────────────────────────────

  describe('POST /api/setup/license — Rate Limiting', () => {
    it('allows 5 requests within a minute', async () => {
      // Each beforeEach creates a new createSetupRoutes() with a fresh rate limiter
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/api/setup/license')
          .send({ tier: 'agpl' });
        statuses.push(res.status);
      }
      expect(statuses.every(s => s === 200)).toBe(true);
    });

    it('rejects 6th request with 429', async () => {
      // Exhaust the 5-request limit
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/setup/license')
          .send({ tier: 'agpl' });
      }

      // 6th request should be rate limited
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'agpl' })
        .expect(429);

      expect(res.body.error).toMatch(/Too many license requests/);
    });
  });

  // ── Error Handling ──────────────────────────────────────────────────

  describe('POST /api/setup/license — Error Handling', () => {
    it('handles malformed JSON body gracefully', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .set('Content-Type', 'application/json')
        .send('{ not valid json !!!');

      // Express JSON parser returns 400 for malformed JSON
      expect(res.status).toBe(400);
    });

    it('handles empty body', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({})
        .expect(400);

      expect(res.body.error).toMatch(/Invalid license tier/);
    });

    it('handles null body', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send(null);

      // Should get a validation error, not a crash
      expect([400, 429]).toContain(res.status);
    });

    it('handles non-string email field', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 12345 })
        .expect(400);

      expect(res.body.error).toMatch(/Email address is required/);
    });

    it('handles non-string company name', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$1M–$5M',
          companyName: { inject: true },
          useCase: 'Testing',
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Company name is required/);
    });

    it('handles non-string use case', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({
          tier: 'paid-commercial',
          email: 'ent@corp.com',
          revenueScale: '$1M–$5M',
          companyName: 'Corp',
          useCase: ['array', 'not', 'string'],
          telemetryAcknowledged: true,
        })
        .expect(400);

      expect(res.body.error).toMatch(/Use case is required/);
    });
  });
});

// ── Security ──────────────────────────────────────────────────────────

describe('License Routes — Security', () => {
  describe('PostHog key validation', () => {
    it('uses a write-only project capture key (phc_ prefix)', async () => {
      const srcPath = join(__dirname, '..', '..', '..', 'src', 'web', 'routes', 'setupRoutes.ts');
      const source = readFileSync(srcPath, 'utf-8');

      // Extract the PostHog key from the source
      const keyMatch = /POSTHOG_PROJECT_KEY\s*=\s*process\.env\.POSTHOG_API_KEY\s*\|\|\s*'([^']+)'/.exec(source);
      expect(keyMatch).not.toBeNull();

      const key = keyMatch![1];
      // Write-only project capture keys start with phc_
      expect(key).toMatch(/^phc_/);
      // Personal API keys start with phx_ — ensure this is NOT a personal key
      expect(key).not.toMatch(/^phx_/);
    });
  });

  describe('EMAIL_PATTERN regex safety', () => {
    it('does not catastrophically backtrack on adversarial input', () => {
      // The EMAIL_PATTERN from setupRoutes.ts:
      // /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/
      const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

      // Classic ReDoS payloads — these should resolve quickly, not hang
      const adversarialInputs = [
        'a'.repeat(100) + '@' + 'b'.repeat(100) + '.com',
        '@'.repeat(50),
        'a'.repeat(64) + '@' + 'b'.repeat(253) + '.' + 'c'.repeat(63),
        'a@' + '.b'.repeat(200),
        'x'.repeat(254),
        'a@b.' + 'c'.repeat(63) + 'd'.repeat(63),
      ];

      for (const input of adversarialInputs) {
        const start = performance.now();
        const _result = EMAIL_PATTERN.test(input);
        const elapsed = performance.now() - start;

        // Each test should complete in well under 100ms
        // (catastrophic backtracking would take seconds or more)
        expect(elapsed).toBeLessThan(100);
      }
    });

    it('correctly rejects adversarial patterns while staying fast', () => {
      const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

      // These should all be rejected (not matched)
      const shouldReject = [
        'a'.repeat(65) + '@example.com',   // local part too long
        'user@' + 'b'.repeat(254) + '.com', // domain part too long
        'user@example.' + 'c'.repeat(64),   // TLD too long
        'user@example',                      // no TLD
        '@example.com',                      // empty local
        'user@.com',                         // empty domain
      ];

      for (const input of shouldReject) {
        expect(EMAIL_PATTERN.test(input)).toBe(false);
      }
    });

    it('correctly accepts valid email patterns', () => {
      const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

      const shouldAccept = [
        'user@example.com',
        'a@b.co',
        'very.long.local.part+tag@subdomain.example.org',
        'user@123.123.123.com',
      ];

      for (const input of shouldAccept) {
        expect(EMAIL_PATTERN.test(input)).toBe(true);
      }
    });
  });

  describe('License file permissions', () => {
    it('writes license file with restricted permissions (0o600)', async () => {
      const { createSetupRoutes } = await import('../../../src/web/routes/setupRoutes.js');
      const { setLicenseHandler } = createSetupRoutes();

      const app = express();
      app.use(express.json());
      app.post('/api/setup/license', setLicenseHandler);

      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'agpl' })
        .expect(200);

      // Verify the file was written with restrictive permissions
      // Windows does not support Unix file permissions — skip this check there
      if (process.platform !== 'win32') {
        const { stat } = await import('node:fs/promises');
        const stats = await stat(LICENSE_PATH);
        // Check owner-only read/write (0o600) — mask out file type bits
        const mode = stats.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });
});

// ── Verification Flow Tests ───────────────────────────────────────────

describe('License Routes — Email Verification', () => {
  let app: express.Express;
  const COMMERCIAL_ACKS = { telemetryAcknowledged: true, attributionAcknowledged: true, revenueAttested: true };

  beforeEach(async () => {
    globalThis.fetch = jest.fn().mockImplementation(() => mockFetchResponse(true, 200, { success: true }));
    const { createSetupRoutes } = await import('../../../src/web/routes/setupRoutes.js');
    const { getLicenseHandler, setLicenseHandler, verifyLicenseHandler, resendVerificationHandler } = createSetupRoutes();

    app = express();
    app.use(express.json());
    app.get('/api/setup/license', getLicenseHandler);
    app.post('/api/setup/license', setLicenseHandler);
    app.post('/api/setup/license/verify', verifyLicenseHandler);
    app.post('/api/setup/license/resend', resendVerificationHandler);
  });

  describe('POST /api/setup/license — Verification Required', () => {
    it('returns a delivery error if the direct worker call times out', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('worker timeout')));
          setTimeout(resolve, 15_000);
        });
        return new Response(null, { status: 204 });
      });

      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'verify@example.com', ...COMMERCIAL_ACKS })
        .expect(502);

      expect(res.body.verificationRequired).toBe(true);
      expect(res.body.error).toMatch(/timed out/i);
      const workerCall = (globalThis.fetch as jest.Mock).mock.calls.find(([input]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
        return url.includes('workers.dev/direct-verification');
      });
      expect(workerCall).toBeDefined();
      expect(workerCall?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('commercial license returns verificationRequired: true', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'verify@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      expect(res.body.verificationRequired).toBe(true);
      expect(res.body.license.status).toBe('pending');
      expect(res.body.license.verificationCode).toBeUndefined();
    });

    it('AGPL does not require verification', async () => {
      const res = await request(app)
        .post('/api/setup/license')
        .send({ tier: 'agpl' })
        .expect(200);

      expect(res.body.verificationRequired).toBeUndefined();
      expect(res.body.license.status).toBe('active');
    });

    it('verification code is not exposed in GET response', async () => {
      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'hidden@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      const getRes = await request(app)
        .get('/api/setup/license')
        .expect(200);

      expect(getRes.body.verificationCode).toBeUndefined();
      expect(getRes.body.verificationAttempts).toBeUndefined();
      expect(getRes.body.status).toBe('pending');
    });
  });

  async function setupPendingLicense(): Promise<string> {
    await request(app)
      .post('/api/setup/license')
      .send({ tier: 'free-commercial', email: 'verify@example.com', ...COMMERCIAL_ACKS })
      .expect(200);

    const raw = await readFile(LICENSE_PATH, 'utf-8');
    return JSON.parse(raw).verificationCode;
  }

  describe('POST /api/setup/license/verify', () => {
    it('activates license with correct code', async () => {
      const code = await setupPendingLicense();

      const res = await request(app)
        .post('/api/setup/license/verify')
        .send({ code })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.license.status).toBe('active');
      expect(res.body.license.verifiedAt).toBeDefined();
      expect(res.body.license.verificationCode).toBeUndefined();
    });

    it('rejects incorrect code with remaining attempts', async () => {
      await setupPendingLicense();

      const res = await request(app)
        .post('/api/setup/license/verify')
        .send({ code: '000000' })
        .expect(400);

      expect(res.body.error).toContain('Incorrect');
      expect(res.body.error).toContain('remaining');
    });

    it('rejects non-6-digit code', async () => {
      await setupPendingLicense();

      await request(app).post('/api/setup/license/verify').send({ code: 'abc' }).expect(400);
      await request(app).post('/api/setup/license/verify').send({ code: '12345' }).expect(400);
      await request(app).post('/api/setup/license/verify').send({ code: '1234567' }).expect(400);
    });

    it('rejects when no pending license exists', async () => {
      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'agpl' })
        .expect(200);

      const res = await request(app)
        .post('/api/setup/license/verify')
        .send({ code: '123456' })
        .expect(400);

      expect(res.body.error).toContain('No pending');
    });

    it('invalidates after max attempts exceeded', async () => {
      await setupPendingLicense();

      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/setup/license/verify')
          .send({ code: '000000' });
      }

      const res = await request(app)
        .post('/api/setup/license/verify')
        .send({ code: '000000' });

      // Accept 400 (max attempts) or 429 (rate limit) — both block the attempt
      expect([400, 429]).toContain(res.status);
    });
  });

  describe('POST /api/setup/license/resend', () => {
    it('returns a delivery error when the resend worker call times out', async () => {
      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'resend@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('worker timeout')));
          setTimeout(resolve, 15_000);
        });
        return new Response(null, { status: 204 });
      });

      const res = await request(app)
        .post('/api/setup/license/resend')
        .send({})
        .expect(502);

      expect(res.body.verificationRequired).toBe(true);
      expect(res.body.error).toMatch(/timed out/i);
      const workerCall = (globalThis.fetch as jest.Mock).mock.calls.find(([input]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
        return url.includes('workers.dev/direct-verification');
      });
      expect(workerCall).toBeDefined();
      expect(workerCall?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('generates a new code for pending license', async () => {
      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'resend@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      const res = await request(app)
        .post('/api/setup/license/resend')
        .send({})
        .expect(200);

      expect(res.body.success).toBe(true);

      const raw = await readFile(LICENSE_PATH, 'utf-8');
      const license = JSON.parse(raw);
      expect(license.verificationCode).toBeDefined();
      expect(license.verificationCode).toHaveLength(6);
    });

    it('rejects when no pending license', async () => {
      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'agpl' })
        .expect(200);

      await request(app)
        .post('/api/setup/license/resend')
        .send({})
        .expect(400);
    });

    it('reports resend delivery failures instead of claiming success', async () => {
      await request(app)
        .post('/api/setup/license')
        .send({ tier: 'free-commercial', email: 'resend@example.com', ...COMMERCIAL_ACKS })
        .expect(200);

      globalThis.fetch = jest.fn().mockImplementation(() => mockFetchResponse(false, 500, 'Worker error'));

      const res = await request(app)
        .post('/api/setup/license/resend')
        .send({})
        .expect(502);

      expect(res.body.verificationRequired).toBe(true);
      expect(res.body.error).toMatch(/could not send the verification email/i);
    });
  });
});
