/* global location, history, document, window */
/** Public configuration only. The browser controller is serialized without module dependencies. */
export interface OnboardingClaimPageConfig {
  readonly claimPath: string; readonly maxTokenLength: number;
  readonly roles: Readonly<Record<string, { readonly name: string; readonly summary: string }>>;
}
interface ClaimMetadata {
  state: 'claimed'; account: { username: string; displayName: string | null; verifiedEmail: string };
  intendedRoles: string[]; invitationExpiresAt: string; sessionExpiresAt: string; serverTime: string;
}

/** Keep this function self-contained: only its compiled source and public config enter the HTML. */
export function startOnboardingClaimPage(config: OnboardingClaimPageConfig): void {
  let sessionContextAllowed = !location.href.includes('#');
  const fragment = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', config.claimPath); // Before fetch, listeners, or reading account data.
  let credential = Array.from(fragment).length === 1 ? fragment.get('token') : null;
  if (!credential || credential.length > config.maxTokenLength) credential = null;
  fragment.delete('token');
  let csrf: string | null = null;
  let busy = false;
  let claimed = false;
  let lifecycle = 0;
  let transport = new AbortController();
  let serverClock: { time: number; started: number; deadline: number } | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const status = document.getElementById('claim-status')!;
  const details = document.getElementById('claim-details')!;
  const accept = document.getElementById('claim-continue') as HTMLButtonElement;
  const retry = document.getElementById('claim-retry') as HTMLButtonElement;
  const logout = document.getElementById('claim-logout') as HTMLButtonElement;
  const github = document.getElementById('claim-github') as HTMLButtonElement;
  const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
  function announce(message: string) { status.textContent = message; status.focus(); }
  function clearDetails() {
    claimed = false; serverClock = null; github.disabled = true;
    details.hidden = true; logout.hidden = true; clearTimeout(expiryTimer);
    for (const id of ['claim-name', 'claim-username', 'claim-email', 'claim-expiry', 'claim-relative', 'claim-roles']) text(id, '');
  }
  async function api(path: string, body?: object): Promise<Record<string, unknown>> {
    const signal = transport.signal;
    const response = await fetch('/auth/onboarding' + path, { method: body ? 'POST' : 'GET', mode: 'same-origin',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf && path !== '/bootstrap' ? { 'X-Onboarding-CSRF': csrf } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => { throw new Error('temporary'); });
    if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'temporary' : 'unavailable');
    const result = response.status === 204 ? {} : await response.json().catch(error => { throw new Error(error?.name === 'SyntaxError' ? 'unavailable' : 'temporary'); }) as Record<string, unknown>;
    if (signal.aborted) throw new Error('unavailable');
    return result;
  }
  function readCsrf(value: unknown) {
    if (typeof value !== 'string' || !value || value.length > 160) throw new Error('unavailable');
    csrf = value;
  }
  async function context() {
    const started = performance.now();
    const value = await api('/context') as unknown as ClaimMetadata;
    const account = value.account;
    const server = Date.parse(value.serverTime), invitationExpiry = Date.parse(value.invitationExpiresAt), sessionExpiry = Date.parse(value.sessionExpiresAt);
    if (value.state !== 'claimed' || !account || typeof account.username !== 'string' || typeof account.verifiedEmail !== 'string' ||
      (account.displayName !== null && typeof account.displayName !== 'string') || !Array.isArray(value.intendedRoles) ||
      value.intendedRoles.some(role => !Object.hasOwn(config.roles, role)) ||
      !Number.isFinite(server) || !Number.isFinite(invitationExpiry) || !Number.isFinite(sessionExpiry) ||
      invitationExpiry <= server || sessionExpiry <= server) throw new Error('unavailable');
    const remaining = Math.min(sessionExpiry, invitationExpiry) - server - (performance.now() - started);
    if (remaining <= 0) throw new Error('unavailable');
    text('claim-name', account.displayName ?? account.username); text('claim-username', account.username); text('claim-email', account.verifiedEmail);
    text('claim-expiry', new Date(invitationExpiry).toUTCString());
    const minutes = Math.ceil((invitationExpiry - server) / 60000);
    text('claim-relative', `About ${minutes < 120 ? minutes + ' minutes' : Math.ceil(minutes / 60) + ' hours'} remaining when checked.`);
    const list = document.getElementById('claim-roles')!;
    list.replaceChildren();
    for (const role of value.intendedRoles) {
      const item = document.createElement('li'); item.textContent = config.roles[role].name + ': ' + config.roles[role].summary; list.append(item);
    }
    if (!value.intendedRoles.length) list.textContent = 'Access to your own permitted console and MCP features after activation; no server administration.';
    serverClock = { time: server, started, deadline: Math.min(sessionExpiry, invitationExpiry) };
    claimed = true;
    details.hidden = false; logout.hidden = false; accept.hidden = true; retry.hidden = true;
    announce('Email verified. Review your invitation. Use a GitHub account with a verified primary email.');
    expiryTimer = setTimeout(() => { clearDetails(); csrf = null; announce('This onboarding session is no longer available. Reopen your invitation email to continue.'); },
      remaining);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    const current = lifecycle;
    busy = true; accept.disabled = true; retry.disabled = true; logout.disabled = true; github.disabled = true;
    try { await action(); }
    catch (error) {
      if (current !== lifecycle) return;
      clearDetails(); csrf = null; accept.hidden = true; retry.hidden = false;
      announce(error instanceof Error && error.message === 'temporary'
        ? 'Temporarily unavailable. Try again shortly or contact support.'
        : 'Unable to continue with this invitation. Reopen the newest invitation email or contact support.');
    } finally { if (current === lifecycle) { busy = false; accept.disabled = !credential || !csrf; retry.disabled = false; logout.disabled = false; github.disabled = !claimed || !csrf; } }
  }
  async function bootstrap() {
    clearDetails(); announce('Preparing your invitation…');
    const result = await api('/bootstrap', {}); readCsrf(result.csrfToken);
    if (!['ready', 'claimed'].includes(String(result.state))) throw new Error('unavailable');
    if (result.state === 'claimed' && !credential && sessionContextAllowed) { await context(); return; }
    accept.hidden = !credential; retry.hidden = true;
    announce(credential ? 'Continue to verify your invitation email. This will not activate your account.'
      : 'Open the newest invitation link from your email to continue.');
  }
  accept.addEventListener('click', () => { void run(async () => {
    if (!credential || !csrf) throw new Error('unavailable');
    announce('Verifying your invitation…');
    const result = await api('/exchange', { credential });
    credential = null; sessionContextAllowed = true; readCsrf(result.csrfToken); await context();
  }); });
  github.addEventListener('click', () => { void run(async () => {
    if (!claimed || !csrf) throw new Error('unavailable');
    announce('Preparing your GitHub connection…');
    const result = await api('/github/start', {});
    if (typeof result.authorizationUrl !== 'string' || result.authorizationUrl.length > 4096 ||
      typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('unavailable');
    // Use the context server clock plus monotonic elapsed time, including response latency.
    // Recheck the claim because its expiry timer may have fired while start was pending.
    if (!claimed || !csrf || !serverClock ||
      Math.min(Date.parse(result.expiresAt), serverClock.deadline) <= serverClock.time + performance.now() - serverClock.started) throw new Error('unavailable');
    const destination = new URL(result.authorizationUrl);
    if (destination.origin !== 'https://github.com' || destination.pathname !== '/login/oauth/authorize' ||
      destination.username || destination.password || destination.hash) throw new Error('unavailable');
    credential = null; csrf = null; clearDetails();
    announce('Opening GitHub to connect your login.');
    location.assign(destination.href);
  }); });
  retry.addEventListener('click', () => { void run(bootstrap); }); // Refresh CSRF only; never replay an exchange automatically.
  logout.addEventListener('click', () => { void run(async () => {
    await api('/logout', {}); credential = null; csrf = null; clearDetails();
    accept.hidden = true; retry.hidden = true; announce('You have signed out of onboarding. Reopen your invitation email to continue.');
  }); });
  window.addEventListener('pagehide', () => { lifecycle++; transport.abort(); busy = false; credential = null; csrf = null; clearDetails(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { transport = new AbortController(); void run(bootstrap); } });
  void run(bootstrap);
}
