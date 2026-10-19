import { isAcceptedSseResponse } from './SseResponse.js';
import { atDeadline } from '../../utils/timers.js';
import type { AuthClaims, CredentialBinding } from '../../auth/IAuthProvider.js';
import type { ServerResponse } from 'node:http';
import { gateStreamWrites } from './StreamCredentialGate.js';

// Poll idle headers promptly at 5ms; writes inspect before payloads too, and polling stops at commit or the 10s deadline.
const HEADER_OBSERVATION_MS = 5;
const HEADER_DEADLINE_MS = 10_000;
// Bound old SDK reader retirement; timeout closes the session instead of risking misrouted notifications.
// Independent of HEADER_DEADLINE_MS: this bounds retiring an old reader, not observing new response headers.
export const STREAM_RETIREMENT_TIMEOUT_MS = 5_000;
// Leave four seconds for SDK reader retirement after a non-draining close falls back.
export const STREAM_CLOSE_FALLBACK_MS = 1_000;

export interface StreamObservation {
  readonly accepted: boolean;
  /** Returns whether a single tools/list_changed resync is needed. */
  renewCredential(expiresAt: number | undefined, binding: StreamCredentialBinding | undefined): boolean;
  closeGracefully(): void;
  inspect(): void;
  stop(): void;
}

export interface StreamCredentialBinding extends CredentialBinding { sub: string; tenantId?: string | null }

export function streamCredentialBinding(claims?: AuthClaims): StreamCredentialBinding | undefined {
  return claims ? { ...claims.credentialBinding, sub: claims.sub, tenantId: claims.tenantId ?? undefined } : undefined;
}

function sameBinding(left?: StreamCredentialBinding, right?: StreamCredentialBinding): boolean {
  if (!left || !right) return false;
  const keys = ['sub', 'tenantId', 'issuer', 'clientId', 'authorizedParty', 'grantId', 'sessionId'] as const;
  return keys.every(key => left[key] === right[key]);
}

/** Observe public response state without replacing SDK callbacks or writeHead. */
export function observeStream(response: ServerResponse, options: {
  isCurrent(): boolean;
  onOpen(): void;
  onClose(): void;
  expiresAt?: number;
  binding?: StreamCredentialBinding;
  suppressPayloads?(): boolean;
  onCredentialRenewed?(): void;
  onCredentialExpired?(): void;
  onCredentialPayloadDropped?(): void;
  /** Optional wall-clock cap; zero or omitted never closes on a wall-clock deadline. */
  maxLifetimeMs?: number;
  /** Credential expiry grace in milliseconds; zero or omitted disables the bound. */
  expiryGraceMs?: number;
  /** End the SDK standalone stream without destroying its draining socket. */
  closeStream?(): void;
}): StreamObservation {
  let accepted = false;
  let stopped = false;
  let stopLifetime: (() => void) | undefined;
  let stopCredentialExpiry: (() => void) | undefined;
  let stopExpiryGrace: (() => void) | undefined;
  let stopGracefulClose: (() => void) | undefined;
  let closing = false;
  let credentialExpired = false;
  let droppedWhileExpired = false;
  let expiresAt = options.expiresAt;
  const binding = options.binding ? { ...options.binding } : undefined;
  const startedAt = Date.now();
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(observation);
    stopLifetime?.();
    stopCredentialExpiry?.();
    stopExpiryGrace?.();
    stopGracefulClose?.();
    stopGate();
    response.off('close', close);
    response.off('finish', close);
    response.off('error', close);
  };
  const close = (): void => {
    if (stopped) return;
    stop();
    if (accepted) options.onClose();
  };
  const closeGracefully = (): void => {
    if (stopped || closing) return;
    closing = true;
    // A non-draining socket cannot complete a graceful end; bound that wait.
    stopGracefulClose = atDeadline(Date.now() + STREAM_CLOSE_FALLBACK_MS, () => response.destroy());
    try {
      if (options.closeStream) options.closeStream();
      else response.end();
    } catch {
      // SDK/network close errors cannot leave a reader owning the routing map.
      response.destroy();
    }
  };
  const expireCredential = (): void => {
    if (stopped || credentialExpired) return;
    credentialExpired = true;
    if (expiresAt !== undefined && options.expiryGraceMs && options.expiryGraceMs > 0) {
      stopExpiryGrace = atDeadline(expiresAt + options.expiryGraceMs, closeGracefully);
    }
    options.onCredentialExpired?.();
  };
  const inspect = (): void => {
    if (stopped || accepted) return;
    // Before acceptance there is no established SDK stream to end gracefully.
    if (!options.isCurrent()) { stop(); response.destroy(); return; }
    if (response.destroyed || response.writableEnded) { close(); return; }
    if (!response.headersSent) {
      if (Date.now() - startedAt >= HEADER_DEADLINE_MS) { stop(); response.destroy(); }
      return;
    }
    if (!isAcceptedSseResponse(response)) {
      stop();
      return;
    }
    accepted = true;
    clearInterval(observation);
    const cap = options.maxLifetimeMs && options.maxLifetimeMs > 0 ? startedAt + options.maxLifetimeMs : Infinity;
    if (Number.isFinite(cap)) stopLifetime = atDeadline(cap, closeGracefully);
    if (expiresAt !== undefined && Number.isFinite(expiresAt)) {
      stopCredentialExpiry = atDeadline(expiresAt, expireCredential);
    }
    options.onOpen();
  };
  const renewCredential = (nextExpiry: number | undefined, nextBinding: StreamCredentialBinding | undefined): boolean => {
    if (stopped || closing || !accepted || !options.isCurrent() || response.destroyed || response.writableEnded) return false;
    if (nextExpiry === undefined || !Number.isFinite(nextExpiry) || expiresAt === undefined
      || nextExpiry <= expiresAt || nextExpiry <= Date.now() || !sameBinding(binding, nextBinding)) return false;
    const wasExpired = credentialExpired || Date.now() >= expiresAt;
    stopCredentialExpiry?.();
    stopExpiryGrace?.();
    stopExpiryGrace = undefined;
    expiresAt = nextExpiry;
    credentialExpired = false;
    stopCredentialExpiry = atDeadline(expiresAt, expireCredential);
    if (wasExpired) options.onCredentialRenewed?.();
    const resync = droppedWhileExpired;
    droppedWhileExpired = false;
    return resync;
  };
  const observation = setInterval(inspect, HEADER_OBSERVATION_MS);
  observation.unref();
  const stopGate = gateStreamWrites(response, () => {
    // Check synchronously at the write boundary too: a busy event loop must not
    // leak a payload just because the expiry timer has not run yet.
    inspect();
    if (accepted && expiresAt !== undefined && Date.now() >= expiresAt) expireCredential();
    return credentialExpired || options.suppressPayloads?.() === true;
  }, () => {
    if (credentialExpired) {
      droppedWhileExpired = true;
      options.onCredentialPayloadDropped?.();
    }
  });
  response.once('close', close);
  response.once('finish', close);
  response.once('error', close);
  return { get accepted() { return accepted; }, renewCredential, closeGracefully, inspect, stop };
}

/** Per-session identity fences are supplied by the owning transport map. */
export class SessionIdleExpiry {
  private timer: (() => void) | undefined;
  private anchor = Date.now();
  private stream: ServerResponse | undefined;
  private disposed = false;

  constructor(private readonly timeoutMs: number, private readonly isCurrent: () => boolean, private readonly expire: () => void) {}

  touch(): void {
    this.anchor = Date.now();
    this.schedule();
  }

  open(response: ServerResponse): void {
    // A disposed session cannot accept or recover a stream; this is terminal teardown.
    if (this.disposed) { response.destroy(); return; }
    this.stream = response;
    this.clear();
  }

  close(response: ServerResponse): boolean {
    if (this.disposed || this.stream !== response) return false;
    this.stream = undefined;
    this.touch();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.stream = undefined;
  }

  private clear(): void {
    this.timer?.();
    this.timer = undefined;
  }

  private schedule(): void {
    this.clear();
    if (this.disposed || this.stream || this.timeoutMs <= 0) return;
    this.timer = atDeadline(this.anchor + this.timeoutMs, () => {
      if (this.disposed || !this.isCurrent() || this.stream) return;
      if (Date.now() - this.anchor < this.timeoutMs) { this.schedule(); return; }
      this.expire();
    });
  }
}

/** Never admit a replacement while an old SDK reader can still cancel routing. */
export async function waitForStreamRetirement(done: Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), STREAM_RETIREMENT_TIMEOUT_MS); timer.unref(); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
