import { describe, expect, it } from '@jest/globals';

import { ALL_AUTH_METHOD_IDS } from '../../../src/auth/embedded-as/AuthMethodFactory.js';
import {
  isSharedHostedWebConsoleDeployment,
  resolveWebConsoleActivationProfile,
  WEB_CONSOLE_SINGLE_USER_AUTH_METHODS,
} from '../../../src/web-console/WebConsoleActivationProfile.js';

const SHARED_HOSTED_PROFILE = 'shared-hosted';

describe('WebConsoleActivationProfile', () => {
  it('keeps development activation for loopback or single-user deployment signals', () => {
    expect(resolveWebConsoleActivationProfile({
      deploymentSignal: {
        httpHost: '127.0.0.1',
        authMethods: ['github'],
      },
    })).toBe('development');
    expect(resolveWebConsoleActivationProfile({
      deploymentSignal: {
        httpHost: '0.0.0.0',
        authMethods: ['trivial-consent'],
      },
    })).toBe('development');
  });

  it('derives shared-hosted activation from exposed multi-user auth methods', () => {
    expect(isSharedHostedWebConsoleDeployment({
      httpHost: '0.0.0.0',
      authMethods: ['github'],
    })).toBe(true);
    expect(resolveWebConsoleActivationProfile({
      deploymentSignal: {
        httpHost: '::',
        authMethods: ['local-password'],
      },
    })).toBe(SHARED_HOSTED_PROFILE);
  });

  it('derives shared-hosted activation from a non-loopback public base URL behind a loopback bind', () => {
    expect(resolveWebConsoleActivationProfile({
      deploymentSignal: {
        httpHost: '127.0.0.1',
        publicBaseUrl: 'https://console.example.test',
        authMethods: ['github'],
      },
    })).toBe(SHARED_HOSTED_PROFILE);
    expect(resolveWebConsoleActivationProfile({
      deploymentSignal: {
        httpHost: '127.0.0.1',
        publicBaseUrl: 'http://localhost:3000',
        authMethods: ['github'],
      },
    })).toBe('development');
  });

  it('treats unknown future auth methods as hosted rather than failing open', () => {
    expect(resolveWebConsoleActivationProfile({
      deploymentSignal: {
        httpHost: '0.0.0.0',
        authMethods: ['future-method'],
      },
    })).toBe(SHARED_HOSTED_PROFILE);
  });

  it('keeps the single-user auth-method denylist tied to canonical auth method IDs', () => {
    for (const method of WEB_CONSOLE_SINGLE_USER_AUTH_METHODS) {
      expect(ALL_AUTH_METHOD_IDS).toContain(method);
    }
  });

  it('lets the authoritative deployment signal activate hosted checks even if an explicit development profile was supplied', () => {
    expect(resolveWebConsoleActivationProfile({
      activationProfile: 'development',
      deploymentSignal: {
        httpHost: '0.0.0.0',
        authMethods: ['magic-link'],
      },
    })).toBe(SHARED_HOSTED_PROFILE);
  });

  it('supports explicit hosted activation without a concrete HTTP signal', () => {
    expect(resolveWebConsoleActivationProfile({
      deploymentSignal: { sharedHosted: true },
    })).toBe(SHARED_HOSTED_PROFILE);
  });
});
