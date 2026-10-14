import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import request from 'supertest';
import { offlineAccessConsentHandlers, offlineAccessParConsentHandlers, requireOfflineAccessConsent } from '../../../../src/auth/embedded-as/offlineAccessConsent.js';

describe('offline access consent normalization', () => {
  it.each([
    ['scope=mcp+offline_access', 'consent'],
    ['scope=offline_access&prompt=login', 'login consent'],
    ['scope=offline_access&prompt=consent', 'consent'],
    ['scope=offline_access&prompt=none', 'none'],
    ['scope=mcp', null],
    ['scope=offline_access&request=signed-jwt', null],
    ['scope=offline_access&request_uri=urn:example', null],
    ['scope=mcp&scope=offline_access', null],
  ])('normalizes %s without bypassing provider validation', (query, prompt) => {
    const params = new URLSearchParams(query);
    const scopes = params.getAll('scope');
    requireOfflineAccessConsent(params);
    expect(params.get('prompt')).toBe(prompt);
    expect(params.getAll('scope')).toEqual(scopes);
  });

  it('does not reserialize a GET URL whose prompt is unchanged', () => {
    const url = '/auth?scope=mcp%20openid&state=%7e';
    const req = { method: 'GET', url } as Request;
    const next = jest.fn();
    offlineAccessConsentHandlers()[0](req, {} as Response, next);
    expect(req.url).toBe(url);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves duplicate prompt parameters for provider rejection', () => {
    const params = new URLSearchParams('scope=offline_access&prompt=login&prompt=select_account');
    requireOfflineAccessConsent(params);
    expect(params.getAll('prompt')).toEqual(['login', 'select_account']);
  });
});


describe('OAuth parameter validation without normalization', () => {
  const queries = [
    'scope=' + encodeURIComponent('ｏffline_access'),
    'scope=' + encodeURIComponent('оffline_access'),
    'scope=offline_access&prompt=' + encodeURIComponent('cоnsent'),
    'scope=offline_access&prompt=' + encodeURIComponent('ｎone'),
    'scope=offline_access&pr%6Fmpt=login',
    'scope=offline_access&prompt',
    encodeURIComponent('scоpe') + '=offline_access',
    'scope=offline_access&prompt=login%00',
    'scope=offline_access&prompt=' + encodeURIComponent('\\u0061'.repeat(11)),
  ];

  it.each(queries)('leaves GET bytes unchanged for %s', query => {
    const url = '/auth?' + query + '&state2=%7e';
    const req = { method: 'GET', url } as Request;
    offlineAccessConsentHandlers()[0](req, {} as Response, jest.fn());
    expect(req.url).toBe(url);
  });

  it.each(queries)('leaves PAR body bytes unchanged for %s', async query => {
    const body = query + '&state2=%7e';
    const app = express();
    app.post('/request', ...offlineAccessParConsentHandlers(), (req, res) => { res.type('text').send(req.body); });
    const response = await request(app).post('/request').type('form').send(body);
    expect(response.status).toBe(200);
    expect(response.text).toBe(body);
  });

  const edits = [
    ['scope=offline_access&login_hint=jos%C3%A9%40example.com&state=%7e',
      'scope=offline_access&login_hint=jos%C3%A9%40example.com&state=%7e&prompt=consent'],
    ['scope=offline_access&state=%C3%28%FF', 'scope=offline_access&state=%C3%28%FF&prompt=consent'],
    ['state=%7e&prompt=login&scope=mcp%20offline_access&other=%FF',
      'state=%7e&prompt=login+consent&scope=mcp%20offline_access&other=%FF'],
    ['scope=offline_access&&', 'scope=offline_access&&prompt=consent'],
  ];

  it.each(edits)('edits only the GET prompt for %s', (raw, expected) => {
    const req = { method: 'GET', url: '/auth?' + raw } as Request;
    offlineAccessConsentHandlers()[0](req, {} as Response, jest.fn());
    expect(req.url).toBe('/auth?' + expected);
  });

  it.each(edits)('edits only the PAR prompt for %s', async (raw, expected) => {
    const app = express();
    app.post('/request', ...offlineAccessParConsentHandlers(), (req, res) => { res.type('text').send(req.body); });
    const response = await request(app).post('/request').type('form').send(raw);
    expect(response.status).toBe(200);
    expect(response.text).toBe(expected);
  });

  it('still requires consent for plain ASCII PAR parameters', async () => {
    const app = express();
    app.post('/request', ...offlineAccessParConsentHandlers(), (req, res) => { res.type('text').send(req.body); });
    const response = await request(app).post('/request').type('form').send('scope=mcp+offline_access&prompt=login');
    expect(response.status).toBe(200);
    expect(new URLSearchParams(response.text).get('prompt')).toBe('login consent');
  });
});

describe('PAR parser errors', () => {
  it.each([
    [413, 'application/x-www-form-urlencoded', 'scope=' + 'x'.repeat(57 * 1024), 'identity'],
    [415, 'application/x-www-form-urlencoded; charset=not-a-charset', 'scope=mcp', 'identity'],
    [400, 'application/x-www-form-urlencoded', 'not a gzip stream', 'gzip'],
  ])('returns generic OAuth JSON for parser status %s', async (status, contentType, body, encoding) => {
    const app = express();
    app.post('/request', ...offlineAccessParConsentHandlers(), (_req, res) => { res.sendStatus(204); });
    const response = await request(app).post('/request').set('Content-Type', contentType).set('Content-Encoding', encoding).send(body);
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'invalid_request', error_description: 'Unable to parse authorization request body.' });
    expect(response.text).not.toMatch(/stack|Error:|\bat .*\(|<!DOCTYPE/i);
  });

  it('passes a server-side parser failure to the normal error handler', async () => {
    const received = jest.fn();
    const app = express();
    // Simulate a misconfigured upstream middleware, which raw-body rejects with 500.
    app.use((req, _res, next) => { req.setEncoding('utf8'); next(); });
    app.post('/request', ...offlineAccessParConsentHandlers(), (_req, res) => { res.sendStatus(204); });
    const handler: ErrorRequestHandler = (error, _req, res, _next) => {
      received(error); res.status(500).json({ error: 'server_error' });
    };
    app.use(handler);
    const response = await request(app).post('/request').type('form').send('scope=mcp');
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ status: 500, type: 'stream.encoding.set' }));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'server_error' });
  });

  it('passes a non-parser downstream error unchanged', async () => {
    const error = Object.assign(new Error('provider failure'), { status: 400 });
    const received = jest.fn();
    const app = express();
    app.post('/request', ...offlineAccessParConsentHandlers(), (_req, _res, next) => { next(error); });
    const handler: ErrorRequestHandler = (err, _req, res, _next) => { received(err); res.sendStatus(502); };
    app.use(handler);
    expect((await request(app).post('/request').type('form').send('scope=mcp')).status).toBe(502);
    expect(received).toHaveBeenCalledWith(error);
  });
});
