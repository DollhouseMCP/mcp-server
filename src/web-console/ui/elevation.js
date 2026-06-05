/**
 * Admin elevation control (shell-level).
 *
 * Renders an "Elevate" affordance near the account chip — but ONLY for users
 * whose role entitles them to admin capabilities (`/auth/me`
 * `available_admin_capabilities` non-empty). For everyone else nothing renders,
 * ever.
 *
 * While elevated it morphs into a live "Admin mode · mm:ss" pill (with an Exit
 * action that calls step-down) and shows a persistent accent band across the top
 * so privileged mode is unmissable. A countdown driven by `elevation.expires_at`
 * reverts the UI the moment elevation lapses — and a `dh:elevation-changed`
 * event lets feature tabs react (e.g. the Logs tab folding in system logs).
 *
 * One step-up grants the session its full role-entitled admin set, so the
 * control elevates with any one of the available capabilities.
 */

import { stepUp, stepDown } from './api.js';
import { fetchFactorStatus, openSecurityPanel } from './security.js';

const ELEVATED_KEY = 'dh-elevated'; // sessionStorage marker → toast only on real transitions
const WARN_THRESHOLD_MS = 60_000;

let toast = () => {};
let control;          // #elevation-control
let band;             // #admin-band
let capabilities = [];
let expiresAt = null;
let tick = null;
let warned = false;

export function initElevation(principal, ctx = {}) {
  toast = ctx.toast || toast;
  control = document.getElementById('elevation-control');
  band = document.getElementById('admin-band');
  capabilities = Array.isArray(principal?.available_admin_capabilities)
    ? principal.available_admin_capabilities
    : [];

  // Hard gate: non-admins never see any elevation UI.
  if (capabilities.length === 0) {
    hide(control);
    hide(band);
    return;
  }

  render(principal?.elevation);
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

function render(elevation) {
  // An already-past expiry is NOT active: treating it as active would render the
  // elevated UI, immediately trip handleExpiry() (which re-enters render() and
  // nulls expiresAt), then crash on the trailing fmtClock(expiresAt).
  const active = elevation?.active === true
    && !!elevation.expires_at
    && new Date(elevation.expires_at).getTime() > Date.now();
  const prevElevated = sessionStorage.getItem(ELEVATED_KEY) === '1';

  stopTick();
  warned = false;

  if (active) {
    expiresAt = new Date(elevation.expires_at);
    renderElevated();
    startTick();
  } else {
    expiresAt = null;
    renderNormal();
  }

  // Toast only on a genuine transition (survives the step-up page redirect via
  // sessionStorage, but stays quiet on a plain refresh while already elevated).
  if (active && !prevElevated) toast(`Admin access active until ${fmtClock(expiresAt)}.`, 'warn');
  else if (!active && prevElevated) toast('Back to standard access.', 'info');
  sessionStorage.setItem(ELEVATED_KEY, active ? '1' : '0');

  globalThis.dispatchEvent(new CustomEvent('dh:elevation-changed', {
    detail: { active: !!active, capabilities, expiresAt },
  }));
}

function renderNormal() {
  hide(band);
  control.hidden = false;
  control.classList.remove('is-elevated');
  control.innerHTML = `
    <button class="btn btn-elevate" id="elevate-btn" type="button" title="Elevate to admin access (requires a one-time code)">
      <span class="elevate-icon" aria-hidden="true">&#x1f6e1;</span> Elevate
    </button>`;
  control.querySelector('#elevate-btn').addEventListener('click', onElevate);
}

function renderElevated() {
  control.hidden = false;
  control.classList.add('is-elevated');
  control.innerHTML = `
    <span class="admin-pill" id="admin-pill">
      <span class="admin-pill-dot" aria-hidden="true"></span>
      <span class="admin-pill-label">Admin</span>
      <span class="admin-pill-countdown" id="admin-countdown"></span>
      <button class="admin-pill-exit" id="exit-btn" type="button" title="Drop admin access">Exit</button>
    </span>`;
  control.querySelector('#exit-btn').addEventListener('click', onExit);

  band.hidden = false;
  band.classList.add('admin-band--on');
  updateCountdown(); // paint immediately so the band/pill aren't blank for a tick
}

/* ── Countdown ──────────────────────────────────────────────────────────── */

function startTick() {
  tick = setInterval(updateCountdown, 1000);
}

function stopTick() {
  if (tick) { clearInterval(tick); tick = null; }
}

function updateCountdown() {
  if (!expiresAt) return;
  const remaining = expiresAt.getTime() - Date.now();
  if (remaining <= 0) {
    handleExpiry();
    return;
  }
  const text = fmtRemaining(remaining);
  const countdownEl = document.getElementById('admin-countdown');
  if (countdownEl) countdownEl.textContent = `· ${text}`;
  if (band) band.textContent = `ADMIN MODE — access ends ${fmtClock(expiresAt)} (${text})`;

  const urgent = remaining <= WARN_THRESHOLD_MS;
  control.classList.toggle('is-expiring', urgent);
  if (band) band.classList.toggle('admin-band--expiring', urgent);
  if (urgent && !warned) {
    warned = true;
    toast('Admin access expires in under a minute. Re-elevate to extend.', 'warn');
  }
}

function handleExpiry() {
  stopTick();
  // Elevation lapsed on its own — revert the UI and let dependents refresh.
  render({ active: false, expires_at: null });
}

/* ── Actions ──────────────────────────────────────────────────────────────── */

async function onElevate() {
  // Non-dead-end: elevation requires a TOTP factor. If none is enrolled, route
  // into the deliberate enrollment surface instead of bouncing off the AS's
  // "TOTP required" wall.
  const elevateBtn = document.getElementById('elevate-btn');
  if (elevateBtn) elevateBtn.disabled = true;
  const status = await fetchFactorStatus();
  if (elevateBtn) elevateBtn.disabled = false;
  if (!status?.totp?.enrolled) {
    toast('Set up an authenticator first to elevate to admin access.', 'warn');
    openSecurityPanel({ toast });
    return;
  }
  // Any one capability is enough — step-up grants the full role-entitled set.
  // Return to wherever we are now (relative path; validated server-side).
  const activeTab = document.querySelector('.console-tab.active')?.dataset.tab || 'portfolio';
  stepUp(capabilities[0], `/ui?tab=${encodeURIComponent(activeTab)}`);
}

async function onExit() {
  const exitBtn = document.getElementById('exit-btn');
  if (exitBtn) exitBtn.disabled = true;
  try {
    const res = await stepDown();
    if (res.status === 204 || res.status === 200) {
      render({ active: false, expires_at: null });
    } else {
      toast('Could not drop admin access. Try again.', 'error');
      if (exitBtn) exitBtn.disabled = false;
    }
  } catch {
    toast('Could not drop admin access. Try again.', 'error');
    if (exitBtn) exitBtn.disabled = false;
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function hide(el) { if (el) el.hidden = true; }

function fmtClock(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtRemaining(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
