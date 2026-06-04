/**
 * DollhouseMCP web console — shell controller.
 *
 * Owns the cross-cutting concerns: the auth gate (login vs console), tab
 * switching, light/dark theme, toast notifications, and the step-up prompt.
 * Feature modules (portfolio, security, …) are loaded once the gate opens.
 */

import { whoami, login, logout, get } from './api.js';
import { initElevation } from './elevation.js';
import { openSecurityPanel } from './security.js';

const THEME_KEY = 'dh-console-theme';

/* ── Theme ──────────────────────────────────────────────────────────────── */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toDark = theme === 'light';
  const icon = document.getElementById('theme-toggle-icon');
  const label = document.getElementById('theme-toggle-label');
  if (icon) icon.innerHTML = toDark ? '&#9790;' : '&#9728;';
  if (label) label.textContent = toDark ? 'Switch to dark mode' : 'Switch to light mode';
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */

/**
 * Each tab is a self-contained module that renders its own markup + logic into
 * its panel, lazy-loaded on first activation. New tabs drop in here — the shell
 * doesn't change. A module exports `init(panelEl)`.
 */
const TAB_MODULES = {
  portfolio: () => import('./portfolio.js'),
  // security:     () => import('./security.js'),
  sessions: () => import('./sessions.js'),
  logs: () => import('./logs.js'),
  users: () => import('./users-admin.js'),
  // metrics:      () => import('./metrics.js'),
  // integrations: () => import('./integrations.js'),
};
// Memoized load+init promise per tab, so callers (e.g. the Sessions→Logs jump)
// can await a module being ready without racing the lazy import.
const tabModulePromises = new Map();

function initTabs() {
  document.querySelectorAll('.console-tab').forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
}

function activateTab(name) {
  document.querySelectorAll('.console-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const match = panel.id === `tab-${name}`;
    panel.classList.toggle('active', match);
    panel.hidden = !match;
  });
  ensureTabModule(name);
  window.dispatchEvent(new CustomEvent('dh:tab-activated', { detail: { name } }));
}

function ensureTabModule(name) {
  if (!TAB_MODULES[name]) return Promise.resolve();
  if (tabModulePromises.has(name)) return tabModulePromises.get(name);
  const panel = document.getElementById(`tab-${name}`);
  const loading = (async () => {
    const mod = await TAB_MODULES[name]();
    await mod.init?.(panel, { toast, viewSessionLogs });
  })().catch(err => {
    tabModulePromises.delete(name);
    if (panel) panel.innerHTML = '<div class="panel-placeholder">Failed to load this section.</div>';
    console.error(`[console] tab module "${name}" failed to load`, err);
  });
  tabModulePromises.set(name, loading);
  return loading;
}

/**
 * Admin tabs (those with `data-admin-cap`) are revealed ONLY while the session
 * is elevated AND the elevation grants the required capability. Driven by the
 * `dh:elevation-changed` event from the elevation control, so the tab appears
 * the moment admin mode is entered and disappears when it lapses. If elevation
 * drops while an admin tab is active, fall back to the portfolio tab.
 */
function applyAdminTabVisibility({ active, capabilities } = {}) {
  const caps = active ? (capabilities || []) : [];
  document.querySelectorAll('.console-tab[data-admin-cap]').forEach(tab => {
    const allowed = caps.includes(tab.dataset.adminCap);
    tab.hidden = !allowed;
    if (!allowed && tab.classList.contains('active')) activateTab('portfolio');
  });
}

// Cross-link used by the Sessions tab: open the Logs tab filtered to a session.
// Awaits the lazy Logs module so the event isn't dispatched before its listener
// is registered.
async function viewSessionLogs(logSessionId) {
  activateTab('logs');
  await ensureTabModule('logs');
  window.dispatchEvent(new CustomEvent('dh:filter-logs-by-session', { detail: { sessionId: logSessionId } }));
}

/* ── Toasts ─────────────────────────────────────────────────────────────── */

export function toast(message, kind = 'info') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.classList.add('toast--in'), 10);
  setTimeout(() => { el.classList.remove('toast--in'); setTimeout(() => el.remove(), 300); }, 4000);
}

/* ── Account menu ───────────────────────────────────────────────────────── */

function initAccountMenu() {
  const trigger = document.getElementById('site-account');
  const menu = document.getElementById('account-menu');
  if (!trigger || !menu) return;

  const setOpen = (open) => {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== trigger) setOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  document.getElementById('account-security')?.addEventListener('click', () => {
    setOpen(false);
    openSecurityPanel({ toast });
  });
}

/* ── Step-up ────────────────────────────────────────────────────────────── */

function initStepUp() {
  // User-facing surfaces don't require elevation; this is a safety net until the
  // dedicated admin step-up UX lands. It surfaces the requirement and routes to
  // the embedded-AS step-up flow, returning to the console afterwards.
  window.addEventListener('dh:step-up-required', (event) => {
    const { capability, stepUpUrl } = event.detail || {};
    toast(`This action needs fresh admin elevation${capability ? ` (${capability})` : ''}.`, 'warn');
    if (stepUpUrl) {
      const url = new URL(stepUpUrl, window.location.origin);
      url.searchParams.set('return_to', '/ui');
      // Defer so the toast is visible before navigation.
      setTimeout(() => { window.location.href = url.toString(); }, 1200);
    }
  });
}

/* ── Auth gate ──────────────────────────────────────────────────────────── */

function showGate(message) {
  const gate = document.getElementById('auth-gate');
  const shell = document.getElementById('console-shell');
  if (message) document.getElementById('auth-gate-text').textContent = message;
  if (gate) gate.hidden = false;
  if (shell) shell.hidden = true;
}

function showConsole(principal) {
  document.getElementById('auth-gate').hidden = true;
  document.getElementById('console-shell').hidden = false;
  const account = document.getElementById('site-account');
  if (account && principal) {
    // /auth/me has no display name (only user_id + auth_sub); show a friendly
    // immediate label, then upgrade from the profile once it loads.
    account.textContent = principal.username || cleanSub(principal.auth_sub) || 'Signed in';
    get('/me/profile').then(res => {
      if (res.status === 200 && res.body) {
        account.textContent = res.body.display_name || res.body.username || account.textContent;
      }
    }).catch(() => { /* keep the fallback label */ });
  }
  // Render the elevate control (no-op for non-admins).
  initElevation(principal, { toast });
}

// The tab to open on load: the `?tab=` param (e.g. when returning from step-up),
// falling back to portfolio. Validated against the real tabs.
function initialTab() {
  const requested = new URLSearchParams(window.location.search).get('tab');
  const known = [...document.querySelectorAll('.console-tab')].map(t => t.dataset.tab);
  return known.includes(requested) ? requested : 'portfolio';
}

// Strip a provider prefix (e.g. "local_live_user" → "live_user") for a friendlier
// chip than the raw UUID before the profile loads.
function cleanSub(sub) {
  return typeof sub === 'string' ? sub.replace(/^[a-z0-9]+_/, '') : undefined;
}

async function runAuthGate() {
  let principal = null;
  try {
    principal = await whoami();
  } catch {
    showGate('Console API is unreachable. Confirm the server is running, then retry.');
    return;
  }
  if (principal) {
    showConsole(principal);
    window.dispatchEvent(new CustomEvent('dh:authenticated', { detail: { principal } }));
    activateTab(initialTab()); // default tab, or the one we returned to after step-up
  } else {
    showGate();
  }
}

/* ── Bootstrap ──────────────────────────────────────────────────────────── */

function init() {
  initTheme();
  initTabs();
  initAccountMenu();
  initStepUp();
  // Reveal/hide admin-only tabs as elevation comes and goes.
  window.addEventListener('dh:elevation-changed', (e) => applyAdminTabVisibility(e.detail));
  document.getElementById('auth-gate-signin')?.addEventListener('click', () => login('/ui'));
  document.getElementById('logout-btn')?.addEventListener('click', () => logout());
  runAuthGate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
