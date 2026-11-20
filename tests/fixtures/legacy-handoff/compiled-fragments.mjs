// Exact compiled fragments; see compiled-methods.json for image-bound hashes.
export function archivedHandler({ logger, setTimeout, clearTimeout, STORAGE_LAYER_CONFIG }) {
  return class {
    async appendValidated(memoryName, targetMemory, manager, saveKey, priorFailure, input) {
        const { content, tags, metadata, origin } = input;
        const failure = origin.bindingCheck ? this.failedMemorySaves.get(saveKey) : priorFailure;
        if (origin.bindingCheck)
            this.checkCurrentRetained(saveKey, targetMemory);
        // Issue #2329: if a previous save of this memory failed (e.g. disk error),
        // recover before accepting more entries — otherwise they pile up in RAM
        // behind the same failure and are lost on restart.
        this.checkOrigin(origin);
        this.requireLegacyDeferred(manager);
        if (failure) {
            try {
                await this.runInOrigin(failure, () => this.saveMemoryTracked(saveKey, targetMemory, failure.manager, failure));
                this.checkOrigin(origin);
            }
            catch (retryErr) {
                throw this.retainedSaveRetryCause(memoryName, failure, retryErr);
            }
        }
        const before = targetMemory.captureAppendState();
        const policyRemovedBefore = targetMemory.getPolicyRemovedCount();
        const candidate = targetMemory.createAppendCandidate();
        let entryResult;
        // Issue #2329: verify the memory can still be persisted BEFORE reporting
        // success. The disk write below is deferred (debounced), so a validation
        // failure there can never reach the caller — entries were acknowledged with
        // an id and then silently lost when the memory outgrew save limits.
        try {
            entryResult = await candidate.addEntry(content, tags, metadata);
            await manager.assertPersistable(candidate);
        }
        catch (validationErr) {
            throw new Error(`Entry NOT saved to memory '${memoryName}': ` +
                `${validationErr instanceof Error ? validationErr.message : validationErr}`);
        }
        if (origin.bindingCheck)
            this.checkCurrentRetained(saveKey, targetMemory);
        this.checkOrigin(origin);
        this.requireLegacyDeferred(manager);
        if (!targetMemory.commitAppendCandidate(before, candidate, entryResult)) {
            throw new Error(`Entry NOT saved to memory '${memoryName}': memory changed during validation, so the append was not applied. ` +
                `Check the current memory and retry.`);
        }
        this.trackSaveFrequency(memoryName);
        this.debouncedMemorySave(memoryName, targetMemory, manager, origin);
        // Issue #2859: removals are never silent. Expired entries and, for memories
        // with onFull 'evict_oldest', the oldest entries can be removed by this add.
        const removedCount = targetMemory.getPolicyRemovedCount() - policyRemovedBefore;
        // Entry prose begins as untrusted. Return only server-generated receipt
        // fields so the mutation response cannot bypass later rendering controls.
        return {
            id: entryResult.id,
            timestamp: entryResult.timestamp.toISOString(),
            trustLevel: entryResult.trustLevel,
            ...this.removalWarningFields(memoryName, removedCount),
        };
    }

    debouncedMemorySave(memoryName, memory, manager, origin) {
        this.requireLegacyDeferred(manager);
        const key = this.memorySaveKey(memoryName);
        // Capture the originating per-user context now, while a request context is
        // active, so a shutdown flush (which runs with none) can re-establish it.
        this.checkOrigin(origin);
        const existing = this.pendingSaves.get(key);
        if (existing) {
            clearTimeout(existing.timer);
            this.debounceMetrics.coalesced++;
            logger.debug(`[MCPAQLHandler] Coalesced save for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
        }
        let queued;
        const timer = setTimeout(() => {
            if (this.observeDeferredRefusal(manager))
                return;
            if (!origin.bindingCheck) {
                this.pendingSaves.delete(key);
                this.debounceMetrics.written++;
                logger.debug(`[MCPAQLHandler] Flushing debounced save for memory '${memoryName}' (coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written})`);
                this.saveMemoryTracked(key, memory, manager, origin).catch(err => {
                    logger.error(`[MCPAQLHandler] Debounced save failed for memory '${memoryName}' (pending: ${this.pendingSaves.size}, coalesced: ${this.debounceMetrics.coalesced}, written: ${this.debounceMetrics.written}): ${err}`);
                });
                return;
            }
            void this.flushOne(key, memory, manager, 'debounce timer', origin).then(saved => {
                if (this.pendingSaves.get(key) === queued &&
                    (saved || this.failedMemorySaves.get(key)?.memory === memory))
                    this.pendingSaves.delete(key);
            }).catch(err => {
                logger.error(`[MCPAQLHandler] Debounced save retained for memory '${memoryName}': ${err}`);
            });
        }, STORAGE_LAYER_CONFIG.MEMORY_SAVE_DEBOUNCE_MS);
        if (typeof timer === 'object' && 'unref' in timer) {
            timer.unref();
        }
        queued = { timer, memory, manager, ...origin };
        this.pendingSaves.set(key, queued);
    }

    cleanupSession(sessionId) {
        this.reportGuardedPending(sessionId);
        const prefix = `${sessionId}:`;
        if (this.observeDeferredRefusal())
            return;
        for (const [key, entry] of this.failedMemorySaves) {
            if (!key.startsWith(prefix))
                continue;
            void this.runInOrigin(entry, () => this.retryLedgerEntryIfAlive(key, entry, 'Session cleanup')).catch((error) => {
                // The retry helper handles storage failures itself, but retain the ledger
                // if context restoration fails before the retry can run.
                logger.error(`[MCPAQLHandler] Session cleanup could not retry memory '${key}': ${error}`);
            });
        }
        // Non-durability bookkeeping only. Pending saves and their timers are left
        // intact so they fire — and persist — in their propagated per-user context.
        this.deleteByPrefix(this.saveFrequencyCounters, prefix);
    }

    async flushPendingSaves() {
        this.reportGuardedPending();
        if (this.observeDeferredRefusal() && (this.pendingSaves.size || this.failedMemorySaves.size))
            throw this.deferredRefusal();
        const pending = [...this.pendingSaves.entries()];
        for (const [, entry] of pending)
            clearTimeout(entry.timer);
        if (pending.length > 0) {
            logger.info(`[MCPAQLHandler] Flushing ${pending.length} pending memory save(s) on shutdown (total coalesced: ${this.debounceMetrics.coalesced}, total written: ${this.debounceMetrics.written})`);
        }
        const flushedKeys = new Set();
        for (const [key, entry] of pending) {
            const { memory, manager } = entry;
            flushedKeys.add(key);
            const saved = await this.flushOne(key, memory, manager, 'shutdown', entry);
            // A closed boundary/context failure must not drop this or later queued
            // candidates. Preserve newer coalesced work under the same key too.
            if (this.pendingSaves.get(key) === entry &&
                (saved || this.failedMemorySaves.get(key)?.memory === memory))
                this.pendingSaves.delete(key);
        }
        // Retry any failure-ledger entry not already attempted above. Direct Map
        // iteration is safe: saveMemoryTracked only deletes the current key on
        // success, which the iteration protocol tolerates.
        for (const [key, entry] of this.failedMemorySaves) {
            if (flushedKeys.has(key))
                continue;
            const recovered = await this.runInOrigin(entry, () => this.retryLedgerEntryIfAlive(key, entry, 'Shutdown retry'));
            if (recovered) {
                this.debounceMetrics.written++;
            }
        }
    }

    async flushOne(key, memory, manager, reason, origin = {}) {
        try {
            // Re-establish the save's originating per-user context. Shutdown runs with
            // no ambient AsyncLocalStorage context, so without this a file-mode
            // per-user save would resolve to the shared baseDir instead of the owner's.
            await this.runInOrigin(origin, () => this.saveMemoryTracked(key, memory, manager, origin));
            this.debounceMetrics.written++;
            return true;
        }
        catch (err) {
            if (this.observeDeferredRefusal(manager) || origin.bindingCheck)
                throw err;
            const entryCount = typeof memory.getEntries === 'function' ? memory.getEntries().size : 'unknown';
            logger.error(`[MCPAQLHandler] Flush save failed for memory '${key}' on ${reason} (entries: ${entryCount}) — unpersisted entries will be lost if the process exits: ${err}`);
            return false;
        }
    }

    async saveMemoryTracked(key, memory, manager, origin = {}) {
        this.checkOrigin(origin);
        const attempt = (this.memorySaveAttempts.get(key) ?? 0) + 1;
        this.memorySaveAttempts.set(key, attempt);
        let originalProbeToken = null;
        try {
            this.requireLegacyDeferred(manager);
            if (origin.bindingCheck)
                originalProbeToken = manager.getMemoryProbeToken(memory);
            await manager.save(memory);
            this.checkOrigin(origin);
            // A save already in flight cannot be cancelled. Keep its evidence if the
            // boundary closes before bookkeeping; never claim that it rolled back.
            this.requireLegacyDeferred(manager);
            if (this.memorySaveAttempts.get(key) === attempt) {
                this.failedMemorySaves.delete(key);
                // Prune the counter on latest-success so the map stays bounded by
                // currently-failing memories. A stale in-flight save then sees
                // undefined !== its attempt and correctly skips ledger updates.
                this.memorySaveAttempts.delete(key);
            }
        }
        catch (err) {
            if (this.memorySaveAttempts.get(key) === attempt) {
                this.failedMemorySaves.set(key, {
                    error: err instanceof Error ? err : new Error(String(err)),
                    memory,
                    manager,
                    probeToken: this.failedSaveProbeToken(origin, manager, memory, originalProbeToken),
                    // getContext() here returns the ambient context on the normal debounced
                    // path, and the re-established context when retried from the shutdown
                    // flush (flushOne runs saveMemoryTracked inside runInSaveContext).
                    context: origin.context ?? this.contextScope?.getContext?.(),
                    bindingCheck: origin.bindingCheck,
                });
            }
            throw err;
        }
    }

  };
}
export function archivedAql({ logger }) {
  return class {
    cleanupSession(sessionId) {
        const prefix = `${sessionId}:`;
        if (this.memoryProvider) {
            for (const saves of this.tenantSaveHandlers.values())
                saves.cleanupSession(sessionId);
        }
        else
            this.requireOrdinary(this.memorySaveHandler).cleanupSession(sessionId);
        // Remove session-keyed entries from tracking collections
        this.deleteByPrefix(this.executingAgents, prefix);
        this.deleteByPrefix(this.abortedGoals, prefix);
        // Issue #1947: Remove per-session rate limiters
        this.verificationRateLimiters.delete(sessionId);
        this.deadlockReliefIssuanceLimiters.delete(sessionId);
        this.permissionPromptLimiters.delete(sessionId);
        this.cliApprovalLimiters.delete(sessionId);
    }

  };
}
export function archivedSession({ logger }) {
  return class {
    async dispose() {
        await this.disposeSessionServices();
        this.cleanupSharedState();
        logger.debug(`[SessionContainer] Disposed session '${this.sessionId}'`);
    }

    cleanupSharedState() {
        this.safeCleanup('SessionActivationRegistry', (svc) => svc.dispose(this.sessionId));
        this.safeCleanup('gatekeeper', (svc) => svc.disposeSession(this.sessionId));
        // Issue #2329: cleanupSession is deliberately non-writing (it leaves pending
        // memory-save timers to fire in their per-user context), so this is a
        // synchronous bookkeeping cleanup — nothing to await.
        this.safeCleanup('mcpAqlHandler', (svc) => svc.cleanupSession(this.sessionId));
    }

    safeCleanup(serviceName, cleanup) {
        try {
            cleanup(this.parent.resolve(serviceName));
        }
        catch (error) {
            logger.warn(`[SessionContainer] Failed to clean up ${serviceName}`, {
                sessionId: this.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

  };
}
export function archivedSignal({ logger, sessions, sessionTelemetry, clearSessionTimer, options, pooledSessions, clearInterval, disposePreparedSession, httpServer, process, console }) {
  let closingPromise = null;
  let replenishPoolPromise = null;
  let runtimeCommandPollTimer = null;
async function closeHttpServer(httpServer) {
    // Destroy all active sockets so keep-alive connections don't prevent shutdown.
    // httpServer.close() only stops accepting new connections — existing sockets
    // stay alive until their keep-alive timeout expires.
    httpServer.closeAllConnections();
    await new Promise((resolve, reject) => {
        httpServer.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

    const disposeSession = async (sessionId, skipTransportClose = false) => {
        if (!sessionId) {
            return;
        }
        const session = sessions.get(sessionId);
        if (!session) {
            return;
        }
        sessions.delete(sessionId);
        sessionTelemetry.disposed += 1;
        clearSessionTimer(session);
        options.onSessionDisposed?.(sessionId);
        try {
            await options.runtimeSessionControl?.markSessionDisposed(sessionId);
        }
        catch (error) {
            logger.warn('[StreamableHTTP] Failed to mark runtime session disposed', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (!skipTransportClose) {
            await session.transport.close().catch(() => {
                /* transport shutdown is best-effort */
            });
        }
        try {
            await session.attachment.dispose();
        }
        catch (error) {
            logger.warn('[StreamableHTTP] Failed to dispose session attachment', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const shutdown = async () => {
        if (closingPromise) {
            return closingPromise;
        }
        closingPromise = (async () => {
            // Wait for any in-flight pool replenishment to finish.
            // closingPromise is set before this await, so maintainSessionPool()'s
            // while-loop guard (!closingPromise) will stop the loop from continuing
            // to prepareSession() after the current iteration completes.
            if (replenishPoolPromise) {
                await replenishPoolPromise.catch(() => { });
            }
            const allSessions = Array.from(sessions.keys());
            const warmSessions = pooledSessions.splice(0);
            if (runtimeCommandPollTimer) {
                clearInterval(runtimeCommandPollTimer);
                runtimeCommandPollTimer = null;
            }
            for (const sessionId of allSessions) {
                await disposeSession(sessionId);
            }
            for (const preparedSession of warmSessions) {
                await disposePreparedSession(preparedSession);
            }
            await closeHttpServer(httpServer);
        })();
        return closingPromise;
    };

        const handleSignal = (signal) => {
            logger.info(`[StreamableHTTP] Received ${signal}, shutting down...`);
            void shutdown()
                .then(() => process.exit(0))
                .catch((error) => {
                console.error('[DollhouseMCP] Streamable HTTP shutdown failed:', error);
                process.exit(1);
            });
        };

  return handleSignal;
}
