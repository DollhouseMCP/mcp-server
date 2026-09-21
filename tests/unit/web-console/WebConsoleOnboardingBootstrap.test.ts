import { afterEach, expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { bootstrapWebConsoleOnboarding, type WebConsoleOnboardingBootstrapOptions } from '../../../src/web-console/WebConsoleOnboardingBootstrap.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { PostgresRateLimitStore } from '../../../src/auth/embedded-as/storage/PostgresRateLimitStore.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { NodemailerEmailSender } from '../../../src/auth/embedded-as/methods/nodemailerEmailSender.js';
import { resolveSmtpConfiguration } from '../../../src/auth/embedded-as/methods/smtpConfiguration.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';

function fixture(): WebConsoleOnboardingBootstrapOptions {
  const database = { transaction: jest.fn() } as unknown as DatabaseInstance;
  return { database, configuration: { publicBaseUrl: 'https://console.example.test', supportEmail: 'help@example.test',
    github: { clientId: 'auth-client', clientSecret: 'secret-sentinel' }, smtp: { state: 'disabled' } },
  authStorage: new PostgresAuthStorageLayer({ db: database }), rateLimits: new PostgresRateLimitStore(database),
  opaqueValues: new HmacConsoleOpaqueValueService(Buffer.alloc(32, 1)),
  adminAuditKeys: { resolve: async () => ({ keyId: 'audit-test', key: Buffer.alloc(32, 2) }) }, apiEnabled: true, sharedHosted: true,
  accountAdminEnabled: true, publicBaseUrl: 'https://console.example.test' };
}
afterEach(() => jest.restoreAllMocks());

it('is inert when disabled, even with missing production dependencies', async () => {
  const verify = jest.spyOn(NodemailerEmailSender.prototype, 'verify');
  expect(await bootstrapWebConsoleOnboarding({ ...fixture(), configuration: null, database: undefined })).toBeNull();
  expect(verify).not.toHaveBeenCalled();
});

it('constructs one admin descriptor and both public routers without querying or exposing configuration', async () => {
  const options = fixture();
  const composition = await bootstrapWebConsoleOnboarding(options);
  expect(Object.keys(composition!).sort()).toEqual(['adminModule', 'apiRouter', 'claimPageRouter']);
  expect(composition?.adminModule.id).toBe('durable_invitation_admin');
  expect(composition?.apiRouter).toBeInstanceOf(Function);
  expect(composition?.claimPageRouter).toBeInstanceOf(Function);
  expect(options.database?.transaction).not.toHaveBeenCalled();
});

it.each([
  ['API disabled', { apiEnabled: false }], ['not hosted', { sharedHosted: false }],
  ['admin omitted', { accountAdminEnabled: false }], ['different origin', { publicBaseUrl: 'https://other.example.test' }],
  ['no audit keys', { adminAuditKeys: undefined }], ['missing database', { database: undefined }],
  ['memory limiter', { rateLimits: new InMemoryRateLimitStore() }], ['missing authentication', { authStorage: null }],
] as const)('rejects %s before SMTP verification or exposing either router', async (_name, overrides) => {
  const verify = jest.spyOn(NodemailerEmailSender.prototype, 'verify');
  await expect(bootstrapWebConsoleOnboarding({ ...fixture(), ...overrides })).rejects.toThrow('shared PostgreSQL');
  expect(verify).not.toHaveBeenCalled();
});

it.each(['authStorage', 'rateLimits'] as const)('rejects a concrete %s connected to another database', async adapter => {
  const options = fixture();
  const other = { transaction: jest.fn() } as unknown as DatabaseInstance;
  const mismatch = adapter === 'authStorage' ? new PostgresAuthStorageLayer({ db: other }) : new PostgresRateLimitStore(other);
  await expect(bootstrapWebConsoleOnboarding({ ...options, [adapter]: mismatch })).rejects.toThrow('shared PostgreSQL');
  expect(options.database?.transaction).not.toHaveBeenCalled();
});

it('sanitizes SMTP readiness failure before returning any composition', async () => {
  const options = fixture();
  const verify = jest.spyOn(NodemailerEmailSender.prototype, 'verify').mockRejectedValue(new Error('smtp-password-sentinel'));
  const configuration = { ...options.configuration!, smtp: resolveSmtpConfiguration({
    host: 'smtp.example.test', user: 'user', password: 'smtp-password-sentinel', from: 'sender@example.test',
  }) };
  const failure = await bootstrapWebConsoleOnboarding({ ...options, configuration }).catch(error => error as Error);
  expect(failure.message).toBe('Private beta onboarding SMTP readiness verification failed.');
  expect(failure.cause).toBeUndefined();
  expect(verify).toHaveBeenCalledTimes(1);
});

it('owns validated configuration before asynchronous SMTP verification', async () => {
  let verified!: () => void;
  jest.spyOn(NodemailerEmailSender.prototype, 'verify').mockImplementation(() => new Promise<void>(resolve => { verified = resolve; }));
  const options = fixture();
  const configuration = { ...options.configuration!, github: { ...options.configuration!.github },
    smtp: resolveSmtpConfiguration({ host: 'smtp.example.test', user: 'user', password: 'password', from: 'sender@example.test' }),
  };
  const pending = bootstrapWebConsoleOnboarding({ ...options, configuration });
  configuration.github.clientId = 'invalid client';
  configuration.supportEmail = 'invalid';
  verified();
  expect((await pending)?.adminModule.id).toBe('durable_invitation_admin');
});

it.each(['https://console.example.test/', 'https://CONSOLE.EXAMPLE.TEST/', 'https://console.example.test:443'])('accepts the canonical equivalent configured origin %s', async publicBaseUrl => {
  expect((await bootstrapWebConsoleOnboarding({ ...fixture(), publicBaseUrl }))?.adminModule.id)
    .toBe('durable_invitation_admin');
});
