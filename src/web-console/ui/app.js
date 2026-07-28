/**
 * DollhouseMCP web console — shell controller.
 *
 * Owns the cross-cutting concerns: the auth gate (login vs console), tab
 * switching, light/dark theme, toast notifications, and the step-up prompt.
 * Feature modules (portfolio, security, …) are loaded once the gate opens.
 */

import { whoami, login, logout, get } from './api.js';
import { loadConsoleMetadata } from './console-meta.js';
import { initElevation } from './elevation.js';
import { openSecurityPanel } from './security.js';
import { openAccountSettings } from './account-settings.js';

const THEME_KEY = 'dh-console-theme';

/* ── Theme ──────────────────────────────────────────────────────────────── */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toDark = theme === 'light';
  const icon = document.getElementById('theme-toggle-icon');
  const label = document.getElementById('theme-toggle-label');
  if (icon) icon.innerHTML = toDark ? '&#9790;' : '&#9728;';
  if (label) label.textContent = toDark ? 'Switch to dark mode' : 'Switch to light mode';
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
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
  portfolio: {
    load: () => import('./portfolio.js'),
    requiredRoutes: [['GET', '/me/portfolio/elements']],
  },
  sessions: {
    load: () => import('./sessions.js'),
    requiredRoutes: [['GET', '/me/sessions'], ['GET', '/me/security/sessions']],
  },
  logs: {
    load: () => import('./logs.js'),
    requiredRoutes: [['GET', '/me/logs']],
  },
  operations: {
    load: () => import('./operations.js'),
    requiredRoutes: [],
    requiredAnyRoutes: [
      ['GET', '/admin/operate/health'],
      ['GET', '/admin/operate/config'],
      ['GET', '/admin/operate/logs'],
      ['GET', '/admin/operate/metrics'],
      ['GET', '/admin/operate/metrics/system'],
      ['GET', '/admin/operate/sessions'],
    ],
  },
  integrations: {
    load: () => import('./integrations.js'),
    requiredRoutes: [['GET', '/me/integrations']],
  },
  users: {
    load: () => import('./users-admin.js'),
    requiredRoutes: [['GET', '/admin/accounts/users']],
  },
  audit: {
    load: () => import('./audit.js'),
    requiredRoutes: [],
    // Each log is independently composable, so the tab appears when any one of
    // them is present rather than requiring the full set.
    requiredAnyRoutes: [
      ['GET', '/admin/audit/admin'],
      ['GET', '/admin/audit/approvals'],
      ['GET', '/admin/audit/authentication'],
    ],
  },
  security: {
    load: () => import('./security-admin.js'),
    requiredRoutes: [],
    requiredAnyRoutes: [
      ['GET', '/admin/security/signing-keys'],
      ['GET', '/admin/security/auth-policy'],
    ],
  },
};
// Memoized load+init promise per tab, so callers (e.g. the Sessions→Logs jump)
// can await a module being ready without racing the lazy import.
const tabModulePromises = new Map();
let consoleMetadata = null;

function initTabs() {
  document.querySelectorAll('.console-tab').forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
}

function activateTab(name) {
  const requestedTab = document.querySelector(`.console-tab[data-tab="${CSS.escape(name)}"]`);
  if (!requestedTab || requestedTab.hidden) return;
  document.getElementById('console-empty-state')?.setAttribute('hidden', '');
  document.querySelectorAll('.console-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const match = panel.id === `tab-${name}`;
    panel.classList.toggle('active', match);
    panel.hidden = !match;
  });
  ensureTabModule(name);
  globalThis.dispatchEvent(new CustomEvent('dh:tab-activated', { detail: { name } }));
}

function ensureTabModule(name) {
  const definition = TAB_MODULES[name];
  if (!tabDefinitionAvailable(definition, consoleMetadata)) return Promise.resolve();
  if (tabModulePromises.has(name)) return tabModulePromises.get(name);
  const panel = document.getElementById(`tab-${name}`);
  const loading = (async () => {
    const mod = await definition.load();
    await mod.init?.(panel, {
      toast,
      viewSessionLogs,
      manifest: consoleMetadata.manifest,
      roleCatalog: consoleMetadata.roleCatalog,
      hasRoute: consoleMetadata.hasRoute,
    });
  })().catch(error => {
    tabModulePromises.delete(name);
    if (panel) panel.innerHTML = '<div class="panel-placeholder">Failed to load this section.</div>';
    console.error(`[console] tab module "${name}" failed to load`, error);
  });
  tabModulePromises.set(name, loading);
  return loading;
}

function configureAvailableTabs(metadata) {
  consoleMetadata = metadata;
  document.querySelectorAll('.console-tab').forEach(tab => {
    const definition = TAB_MODULES[tab.dataset.tab];
    const available = tabDefinitionAvailable(definition, metadata);
    tab.dataset.featureAvailable = String(available);
    tab.hidden = !available || !!tab.dataset.adminCap;
  });
  const accountSecurity = document.getElementById('account-security');
  if (accountSecurity) accountSecurity.hidden = !metadata.hasRoute('GET', '/me/security/factors');
  const accountSettings = document.getElementById('account-settings');
  if (accountSettings) {
    accountSettings.hidden = !metadata.hasRoute('GET', '/me/profile') && !metadata.hasRoute('GET', '/me/settings');
  }
}

function tabDefinitionAvailable(definition, metadata) {
  if (!definition || !metadata?.hasRoutes(definition.requiredRoutes)) return false;
  if (!definition.requiredAnyRoutes) return true;
  return definition.requiredAnyRoutes.some(([method, path]) => metadata.hasRoute(method, path));
}

function showNoAvailableFeatures() {
  document.querySelectorAll('.console-tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.remove('active');
    panel.hidden = true;
  });
  const emptyState = document.getElementById('console-empty-state');
  if (emptyState) emptyState.hidden = false;
}

function activateNonAdminFallback() {
  const fallback = document.querySelector('.console-tab:not([data-admin-cap]):not([hidden])');
  if (fallback?.dataset.tab) activateTab(fallback.dataset.tab);
  else showNoAvailableFeatures();
}

/**
 * Admin tabs (those with `data-admin-cap`) are revealed ONLY while the session
 * is elevated AND the elevation grants the required capability. Driven by the
 * `dh:elevation-changed` event from the elevation control, so the tab appears
 * the moment admin mode is entered and disappears when it lapses. If elevation
 * drops while an admin tab is active, fall back to the first non-admin tab or
 * the explicit no-features state.
 */
function applyAdminTabVisibility({ active, capabilities } = {}) {
  const caps = active ? (capabilities || []) : [];
  let activeAdminTabRevoked = false;
  document.querySelectorAll('.console-tab[data-admin-cap]').forEach(tab => {
    const allowed = tab.dataset.featureAvailable === 'true' && caps.includes(tab.dataset.adminCap);
    if (!allowed && tab.classList.contains('active')) activeAdminTabRevoked = true;
    tab.hidden = !allowed;
  });
  if (activeAdminTabRevoked) activateNonAdminFallback();
}

// Cross-link used by the Sessions tab: open the Logs tab filtered to a session.
// Awaits the lazy Logs module so the event isn't dispatched before its listener
// is registered.
async function viewSessionLogs(logSessionId) {
  const logsTab = document.querySelector('.console-tab[data-tab="logs"]');
  if (!logsTab || logsTab.hidden) {
    toast('Session logs are not available in this deployment.', 'warn');
    return;
  }
  activateTab('logs');
  await ensureTabModule('logs');
  globalThis.dispatchEvent(new CustomEvent('dh:filter-logs-by-session', { detail: { sessionId: logSessionId } }));
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
    openSecurityPanel({ toast, hasRoute: consoleMetadata?.hasRoute });
  });
  document.getElementById('account-settings')?.addEventListener('click', () => {
    setOpen(false);
    openAccountSettings({ toast, hasRoute: consoleMetadata?.hasRoute || (() => false) });
  });
}

/* ── Step-up ────────────────────────────────────────────────────────────── */

function initStepUp() {
  // User-facing surfaces don't require elevation; this is a safety net until the
  // dedicated admin step-up UX lands. It surfaces the requirement and routes to
  // the embedded-AS step-up flow, returning to the console afterwards.
  globalThis.addEventListener('dh:step-up-required', (event) => {
    const { capability, stepUpUrl } = event.detail || {};
    const capabilitySuffix = capability ? ` (${capability})` : '';
    toast(`This action needs fresh admin elevation${capabilitySuffix}.`, 'warn');
    if (stepUpUrl) {
      const url = new URL(stepUpUrl, globalThis.location.origin);
      url.searchParams.set('return_to', '/ui');
      // Defer so the toast is visible before navigation.
      setTimeout(() => { globalThis.location.href = url.toString(); }, 1200);
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

function showConsole(principal, metadata) {
  configureAvailableTabs(metadata);
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
  initElevation(principal, { toast, hasRoute: metadata.hasRoute });
}

// The tab to open on load: the `?tab=` param (e.g. when returning from step-up),
// falling back to portfolio. Validated against the real tabs.
function initialTab() {
  const requested = new URLSearchParams(globalThis.location.search).get('tab');
  const available = [...document.querySelectorAll('.console-tab:not([hidden])')].map(t => t.dataset.tab);
  if (available.includes(requested)) return requested;
  return available.includes('portfolio') ? 'portfolio' : available[0];
}

// Strip a provider prefix (e.g. "local_live_user" → "live_user") for a friendlier
// chip than the raw UUID before the profile loads.
function cleanSub(sub) {
  return typeof sub === 'string' ? sub.replace(/^[a-z0-9]+_/i, '') : undefined;
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
    let metadata;
    try {
      metadata = await loadConsoleMetadata();
    } catch {
      showGate('Console capabilities could not be loaded. Confirm the server is ready, then retry.');
      return;
    }
    showConsole(principal, metadata);
    globalThis.dispatchEvent(new CustomEvent('dh:authenticated', { detail: { principal } }));
    const tab = initialTab();
    if (tab) activateTab(tab); // default tab, or the one we returned to after step-up
    else showNoAvailableFeatures();
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
  globalThis.addEventListener('dh:elevation-changed', (e) => applyAdminTabVisibility(e.detail));
  globalThis.addEventListener('dh:profile-updated', event => {
    const profile = event.detail?.profile;
    const account = document.getElementById('site-account');
    if (account && profile) account.textContent = profile.display_name || profile.username || account.textContent;
  });
  globalThis.addEventListener('dh:theme-setting-changed', event => {
    const theme = event.detail?.theme;
    if (theme !== 'light' && theme !== 'dark') return;
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  });
  document.getElementById('auth-gate-signin')?.addEventListener('click', () => login('/ui'));
  document.getElementById('logout-btn')?.addEventListener('click', () => logout());
  runAuthGate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
