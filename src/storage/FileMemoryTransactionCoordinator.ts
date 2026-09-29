import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs/promises';
import type { UserIdResolver } from '../database/UserContext.js';
import type { FileMemoryFence } from './FileMemoryFence.js';

const leaseBrand: unique symbol = Symbol('FileMemoryLeaseContext');

/** Runtime ownership is checked with a private WeakMap, not this TypeScript shape. */
export interface FileMemoryLeaseContext {
  readonly [leaseBrand]: true;
}

export interface FileMemoryTransactionScope {
  readonly tenantRoot: string;
  readonly userId: string;
}

export interface FileMemoryTransactionCoordinatorOptions {
  readonly tenantRoot: string;
  readonly getCurrentUserId: UserIdResolver;
  readonly fence: Pick<FileMemoryFence, 'withTenantFence'>;
}

type Phase = 'open' | 'closing' | 'closed';

interface LeaseState {
  readonly coordinator: FileMemoryTransactionCoordinator;
  readonly scope: FileMemoryTransactionScope;
  readonly errors: unknown[];
  tail: Promise<void>;
  phase: Phase;
  poisoned: boolean;
  poisonReason?: unknown;
}

const states = new WeakMap<FileMemoryLeaseContext, LeaseState>();
const transactionFlow = new AsyncLocalStorage<LeaseState>();
const operationFlow = new AsyncLocalStorage<FileMemoryLeaseContext>();

function leaseError(code: string, message: string, cause?: unknown): NodeJS.ErrnoException {
  const error = new Error(message, { cause }) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Unwired shared lease/lifetime primitive for audited file-memory stores.
 * It serializes cooperating operations; it is not an atomic multi-operation
 * commit or rollback protocol. Stores must await every I/O they start inside
 * perform(). Arbitrary raw filesystem work outside store APIs is not tracked.
 *
 * Construct per tenant/request from a root and user captured together. A root
 * DI singleton must not keep one coordinator while its active user root varies.
 */
export class FileMemoryTransactionCoordinator {
  private readonly options: FileMemoryTransactionCoordinatorOptions;

  constructor(options: FileMemoryTransactionCoordinatorOptions) {
    this.options = Object.freeze({ ...options });
  }

  /** Read-only capture for standalone snapshots; it acquires no lease and writes nothing. */
  async captureReadScope(): Promise<FileMemoryTransactionScope> {
    const userId = this.options.getCurrentUserId();
    if (typeof userId !== 'string' || !userId) throw new TypeError('Current user ID is required');
    const suppliedRoot = this.options.tenantRoot;
    const tenantRoot = await fs.realpath(suppliedRoot);
    return Object.freeze({ tenantRoot, userId });
  }

  async withTenantTransaction<T>(
    callback: (context: FileMemoryLeaseContext) => Promise<T> | T,
  ): Promise<T> {
    const current = transactionFlow.getStore();
    if (current && current.phase !== 'closed') {
      throw leaseError('ENESTEDLEASE', 'Nested file-memory tenant transactions are not supported');
    }
    const scope = await this.captureReadScope();
    return this.options.fence.withTenantFence(scope.tenantRoot, () => {
      const context = Object.freeze({ [leaseBrand]: true }) as FileMemoryLeaseContext;
      const state: LeaseState = {
        coordinator: this, scope, errors: [], tail: Promise.resolve(), phase: 'open', poisoned: false,
      };
      states.set(context, state);
      return transactionFlow.run(state, async () => {
        let result!: T;
        let callbackError: unknown;
        let callbackFailed = false;
        try {
          result = await callback(context);
        } catch (error) {
          callbackError = error;
          callbackFailed = true;
          if (!state.poisoned) {
            state.poisoned = true;
            state.poisonReason = error;
          }
        }
        state.phase = 'closing';
        await state.tail;
        state.phase = 'closed';
        if (callbackFailed && state.errors.length) {
          const distinct = [...new Set([callbackError, ...state.errors])];
          if (distinct.length === 1) throw callbackError;
          throw new AggregateError(distinct, 'File-memory transaction callback and tracked operations failed',
            { cause: callbackError });
        }
        if (callbackFailed) throw callbackError;
        if (state.errors.length === 1) throw state.errors[0];
        if (state.errors.length > 1) {
          throw new AggregateError(state.errors, 'Tracked file-memory operations failed');
        }
        return result;
      });
    });
  }

  /**
   * @internal Audited store adapters only: the returned promise and all I/O
   * started by operation must settle before operation resolves. A caller cannot
   * escape the lease by omitting await on this tracked store operation.
   */
  perform<T>(
    context: FileMemoryLeaseContext,
    operation: (scope: FileMemoryTransactionScope) => Promise<T> | T,
  ): Promise<T> {
    const state = states.get(context);
    if (!state) throw leaseError('EINVALIDLEASE', 'Invalid file-memory lease context');
    if (state.coordinator !== this) {
      throw leaseError('EWRONGLEASE', 'File-memory lease belongs to another coordinator');
    }
    if (state.phase !== 'open') throw leaseError('ELEASEEXPIRED', 'File-memory lease is no longer open');
    if (operationFlow.getStore() === context) {
      throw leaseError('ENESTEDOPERATION', 'Nested file-memory store operations are not supported');
    }

    // Queue and register rejection handling synchronously before the next
    // await. Accepted operations execute FIFO even after the callback closes.
    let skipped = false;
    const task = state.tail.then(() => {
      if (state.poisoned) {
        skipped = true;
        throw leaseError('ELEASEABORTED', 'Earlier file-memory operation failed; queued operation was not started',
          state.poisonReason);
      }
      return operationFlow.run(context, () => operation(state.scope));
    });
    const tracked = task.then(
      () => undefined,
      error => {
        if (skipped) return;
        state.errors.push(error);
        if (!state.poisoned) {
          state.poisoned = true;
          state.poisonReason = error;
        }
      },
    );
    state.tail = tracked;
    // Prevent an omitted caller await from becoming an unhandled rejection;
    // the transaction still fails after draining state.errors.
    void task.catch(() => undefined);
    return task;
  }
}
