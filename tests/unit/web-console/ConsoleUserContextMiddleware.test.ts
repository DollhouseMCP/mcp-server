import { EventEmitter } from 'node:events';
import { describe, expect, it } from '@jest/globals';

import { createUserIdResolver, UserContextMissingError } from '../../../src/database/UserContext.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { SessionActivationRegistry } from '../../../src/state/SessionActivationState.js';
import {
  createConsoleUserContextMiddleware,
  type ConsoleRequest,
} from '../../../src/web-console/index.js';

const USER_A = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const USER_B = '118f3d47-73ae-7f10-a0de-0742618d4fb2';

describe('ConsoleUserContextMiddleware', () => {
  it('resolves database user identity from the authenticated console session', async () => {
    const tracker = new ContextTracker();
    const registry = new SessionActivationRegistry('stdio-default');
    const middleware = createConsoleUserContextMiddleware({ contextTracker: tracker, sessionActivationRegistry: registry });
    const resolver = createUserIdResolver(tracker, registry);
    const response = responseEmitter();

    await new Promise<void>((resolve, reject) => {
      middleware(requestFor(USER_A, 1), response, error => {
        if (error) {
          reject(error);
          return;
        }
        try {
          expect(tracker.getSessionContext()).toMatchObject({
            userId: USER_A,
            tenantId: USER_A,
            transport: 'http',
          });
          expect(resolver()).toBe(USER_A);
          resolve();
        } catch (assertionError) {
          reject(assertionError);
        }
      });
    });
    response.emit('finish');
    expect(() => resolver()).toThrow(UserContextMissingError);
  });

  it('isolates concurrent console request contexts', async () => {
    const tracker = new ContextTracker();
    const registry = new SessionActivationRegistry('stdio-default');
    const middleware = createConsoleUserContextMiddleware({ contextTracker: tracker, sessionActivationRegistry: registry });
    const resolver = createUserIdResolver(tracker, registry);

    const [left, right] = await Promise.all([
      resolveDuringRequest(middleware, resolver, requestFor(USER_A, 2)),
      resolveDuringRequest(middleware, resolver, requestFor(USER_B, 3)),
    ]);

    expect(left).toBe(USER_A);
    expect(right).toBe(USER_B);
  });

  it('keeps same-session identity available until all concurrent requests finish', async () => {
    const tracker = new ContextTracker();
    const registry = new SessionActivationRegistry('stdio-default');
    const middleware = createConsoleUserContextMiddleware({ contextTracker: tracker, sessionActivationRegistry: registry });
    const resolver = createUserIdResolver(tracker, registry);
    const firstResponse = responseEmitter();
    const secondResponse = responseEmitter();
    let firstResolved = false;

    await new Promise<void>((resolve, reject) => {
      middleware(requestFor(USER_A, 4), firstResponse, error => {
        if (error) {
          reject(error);
          return;
        }
        try {
          expect(resolver()).toBe(USER_A);
          firstResolved = true;
        } catch (assertionError) {
          reject(assertionError);
        }
      });

      middleware(requestFor(USER_A, 4), secondResponse, error => {
        if (error) {
          reject(error);
          return;
        }
        firstResponse.emit('finish');
        setImmediate(() => {
          try {
            expect(firstResolved).toBe(true);
            expect(resolver()).toBe(USER_A);
            secondResponse.emit('finish');
            resolve();
          } catch (assertionError) {
            reject(assertionError);
          }
        });
      });
    });
  });
});

function resolveDuringRequest(
  middleware: ReturnType<typeof createConsoleUserContextMiddleware>,
  resolver: ReturnType<typeof createUserIdResolver>,
  request: ConsoleRequest,
): Promise<string> {
  const response = responseEmitter();
  return new Promise((resolve, reject) => {
    middleware(request, response, error => {
      if (error) {
        reject(error);
        return;
      }
      setImmediate(() => {
        try {
          resolve(resolver());
          response.emit('finish');
        } catch (assertionError) {
          reject(assertionError);
        }
      });
    });
  });
}

function requestFor(userId: string, hashFill: number): ConsoleRequest {
  return {
    method: 'GET',
    headers: {},
    params: {},
    query: {},
    body: {},
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, hashFill),
      userId,
      authSub: `sub-${userId}`,
      authzVersion: 1,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
  } as ConsoleRequest;
}

function responseEmitter(): EventEmitter {
  return new EventEmitter();
}
