/** Profile and allowlisted account settings self-service panel. */

import { del, get, patch, put } from './api.js';

const THEME_SETTING_KEY = 'display_config.theme';
const PROFILE_PATH = '/me/profile';
const SETTINGS_PATH = '/me/settings';
const THEME_RESET_SELECTOR = '[data-theme-reset]';
const UNSUPPORTED_THEME_VALUE = '__unsupported_saved_theme__';
const SUPPORTED_THEMES = new Set(['light', 'dark']);

export async function openAccountSettings({ hasRoute, toast }) {
  const previousFocus = document.activeElement;
  const panel = accountPanel();
  document.body.appendChild(panel);
  panel.querySelector('[data-account-close]').focus();
  const close = () => {
    panel.remove();
    document.removeEventListener('keydown', onKey);
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  const onKey = event => {
    if (event.key === 'Escape') close();
    if (event.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
    const current = controls.indexOf(document.activeElement);
    const offset = event.shiftKey ? -1 : 1;
    event.preventDefault();
    controls[(current + offset + controls.length) % controls.length]?.focus();
  };
  panel.querySelector('.account-settings-backdrop').addEventListener('click', close);
  panel.querySelectorAll('[data-account-close]').forEach(button => button.addEventListener('click', close));
  document.addEventListener('keydown', onKey);

  const profileForm = panel.querySelector('#account-profile-form');
  const themeForm = panel.querySelector('#account-theme-form');
  profileForm.hidden = !hasRoute('GET', PROFILE_PATH);
  themeForm.hidden = !hasRoute('GET', SETTINGS_PATH);
  profileForm.dataset.canPatch = String(hasRoute('PATCH', PROFILE_PATH));
  themeForm.dataset.canPut = String(hasRoute('PUT', '/me/settings/:key'));
  themeForm.dataset.canDelete = String(hasRoute('DELETE', '/me/settings/:key'));

  const profilePromise = profileForm.hidden ? Promise.resolve() : loadProfile(profileForm, hasRoute);
  const settingsPromise = themeForm.hidden ? Promise.resolve() : loadTheme(themeForm);
  await Promise.all([profilePromise, settingsPromise]);

  profileForm.addEventListener('submit', event => {
    event.preventDefault();
    saveProfile(profileForm, toast);
  });
  themeForm.addEventListener('submit', event => {
    event.preventDefault();
    saveTheme(themeForm, toast);
  });
  themeForm.querySelector(THEME_RESET_SELECTOR).addEventListener('click', () => resetTheme(themeForm, toast));
}

function accountPanel() {
  const panel = document.createElement('div');
  panel.className = 'account-settings-modal';
  panel.id = 'account-settings-modal';
  panel.innerHTML = `
    <div class="account-settings-backdrop"></div>
    <section class="account-settings-card" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
      <header class="security-card-header">
        <div><h2 class="account-settings-title" id="account-settings-title">Profile & settings</h2><p>Manage the small set of account preferences supported by this console.</p></div>
        <button class="security-close" data-account-close type="button" aria-label="Close">&#x2715;</button>
      </header>
      <div class="account-settings-body">
        <form class="account-settings-section" id="account-profile-form" data-settings-form="profile">
          <h3>Profile</h3>
          <p class="account-settings-note">Your username and email are managed by your sign-in provider.</p>
          <label class="portfolio-field"><span>Display name</span><input name="display_name" maxlength="200" disabled></label>
          <dl class="account-settings-meta"><div><dt>Username</dt><dd data-profile-username>Loading…</dd></div><div><dt>Email</dt><dd data-profile-email>Loading…</dd></div></dl>
          <div class="account-settings-feedback" data-profile-feedback aria-live="polite"></div>
          <div class="account-settings-actions"><button class="btn btn-primary" type="submit" disabled>Save profile</button></div>
        </form>
        <form class="account-settings-section" id="account-theme-form" data-settings-form="theme">
          <h3>Appearance</h3>
          <p class="account-settings-note">Theme is the only advanced setting with a stable console contract today.</p>
          <label class="portfolio-field"><span>Theme</span><select name="theme" disabled><option value="light">Light</option><option value="dark">Dark</option></select></label>
          <div class="account-settings-feedback" data-theme-feedback aria-live="polite"></div>
          <div class="account-settings-actions"><button class="btn btn-ghost" data-theme-reset type="button" disabled>Reset saved theme</button><button class="btn btn-primary" type="submit" disabled>Save appearance</button></div>
        </form>
      </div>
      <footer class="account-settings-foot"><button class="btn btn-ghost" data-account-close type="button">Close</button></footer>
    </section>`;
  return panel;
}

async function loadProfile(form, hasRoute) {
  const response = await get(PROFILE_PATH);
  if (response.status !== 200 || !response.body) {
    showFeedback(form, 'profile', detail(response, 'Profile could not be loaded.'), 'error');
    return;
  }
  form.elements.display_name.value = response.body.display_name ?? '';
  form.elements.display_name.disabled = !hasRoute('PATCH', PROFILE_PATH);
  form.querySelector('button[type="submit"]').disabled = !hasRoute('PATCH', PROFILE_PATH);
  form.querySelector('[data-profile-username]').textContent = response.body.username || '—';
  form.querySelector('[data-profile-email]').textContent = response.body.email || 'Not provided';
}

async function saveProfile(form, toast) {
  setFormBusy(form, true);
  try {
    const displayName = form.elements.display_name.value.trim();
    const response = await patch(PROFILE_PATH, { body: { display_name: displayName || null } });
    if (response.status !== 200 || !response.body) {
      showFeedback(form, 'profile', detail(response, 'Profile could not be saved.'), 'error');
      return;
    }
    showFeedback(form, 'profile', 'Profile saved.', 'success');
    globalThis.dispatchEvent(new CustomEvent('dh:profile-updated', { detail: { profile: response.body } }));
    toast('Profile saved.', 'success');
  } catch {
    showFeedback(form, 'profile', 'Profile could not reach the server.', 'error');
  } finally {
    setFormBusy(form, false);
  }
}

async function loadTheme(form) {
  const response = await get(SETTINGS_PATH);
  if (response.status !== 200 || !response.body) {
    showFeedback(form, 'theme', detail(response, 'Settings could not be loaded.'), 'error');
    return;
  }
  const savedTheme = response.body.display_config?.theme;
  form.dataset.etag = response.etag || response.body.etag || '';
  form.dataset.hasSavedTheme = String(savedTheme !== undefined && savedTheme !== null);
  setThemeSelection(form, savedTheme);
  setFormBusy(form, false);
}

async function saveTheme(form, toast) {
  setFormBusy(form, true);
  try {
    const theme = form.elements.theme.value;
    const response = await put(`/me/settings/${THEME_SETTING_KEY}`, {
      body: { value: theme },
      ifMatch: form.dataset.etag,
    });
    if (response.status === 412) return settingsConflict(form, toast);
    if (response.status !== 200) {
      showFeedback(form, 'theme', detail(response, 'Appearance could not be saved.'), 'error');
      return;
    }
    form.dataset.etag = response.etag || response.body?.etag || '';
    form.dataset.hasSavedTheme = 'true';
    setThemeSelection(form, theme);
    applySavedTheme(theme);
    showFeedback(form, 'theme', 'Appearance saved.', 'success');
    toast('Appearance saved.', 'success');
  } catch {
    showFeedback(form, 'theme', 'Settings could not reach the server.', 'error');
  } finally {
    setFormBusy(form, false);
  }
}

async function resetTheme(form, toast) {
  setFormBusy(form, true);
  try {
    const response = await del(`/me/settings/${THEME_SETTING_KEY}`, { ifMatch: form.dataset.etag });
    if (response.status === 412) return settingsConflict(form, toast);
    if (response.status !== 200) {
      showFeedback(form, 'theme', detail(response, 'Saved appearance could not be reset.'), 'error');
      return;
    }
    form.dataset.etag = response.etag || response.body?.etag || '';
    form.dataset.hasSavedTheme = 'false';
    setThemeSelection(form, null);
    applySavedTheme('light');
    showFeedback(form, 'theme', 'Saved theme reset to the default.', 'success');
    toast('Saved theme reset.', 'success');
  } catch {
    showFeedback(form, 'theme', 'Settings could not reach the server.', 'error');
  } finally {
    setFormBusy(form, false);
  }
}

async function settingsConflict(form, toast) {
  showFeedback(form, 'theme', 'Settings changed elsewhere. Your choice was not saved; the latest settings are being loaded.', 'error');
  toast('Appearance was not overwritten because settings changed elsewhere.', 'warn');
  await loadTheme(form);
}

function applySavedTheme(theme) {
  // The app shell owns theme application and persists this event contract.
  globalThis.dispatchEvent(new CustomEvent('dh:theme-setting-changed', { detail: { theme } }));
}

function setThemeSelection(form, savedTheme) {
  form.elements.theme.querySelector('[data-unsupported-theme]')?.remove();
  if (savedTheme === undefined || savedTheme === null) {
    form.dataset.themeSupported = 'true';
    form.elements.theme.value = 'light';
    return;
  }
  if (typeof savedTheme === 'string' && SUPPORTED_THEMES.has(savedTheme)) {
    form.dataset.themeSupported = 'true';
    form.elements.theme.value = savedTheme;
    return;
  }

  const option = document.createElement('option');
  option.dataset.unsupportedTheme = 'true';
  option.value = UNSUPPORTED_THEME_VALUE;
  option.textContent = `Unsupported saved value: ${settingValueLabel(savedTheme)}`;
  form.elements.theme.appendChild(option);
  form.elements.theme.value = UNSUPPORTED_THEME_VALUE;
  form.dataset.themeSupported = 'false';
  showFeedback(form, 'theme', 'The saved theme is not supported by this console. Reset it before choosing a new theme.', 'warn');
}

function settingValueLabel(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function setFormBusy(form, busy) {
  form.setAttribute('aria-busy', String(busy));
  if (form.dataset.settingsForm === 'profile') {
    form.elements.display_name.disabled = busy || form.dataset.canPatch !== 'true';
    form.querySelector('button[type="submit"]').disabled = busy || form.dataset.canPatch !== 'true';
    return;
  }
  const canEditTheme = form.dataset.canPut === 'true' && form.dataset.themeSupported !== 'false';
  form.elements.theme.disabled = busy || !canEditTheme;
  form.querySelector('button[type="submit"]').disabled = busy || !canEditTheme;
  const hasSavedTheme = form.dataset.hasSavedTheme === 'true';
  form.querySelector(THEME_RESET_SELECTOR).disabled = busy || !hasSavedTheme || form.dataset.canDelete !== 'true';
}

function showFeedback(form, area, message, kind) {
  form.querySelector(`[data-${area}-feedback]`).innerHTML = `<p class="portfolio-message portfolio-message--${kind}">${escapeHtml(message)}</p>`;
}

function detail(response, fallback) {
  return typeof response.body?.detail === 'string' ? response.body.detail : fallback;
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
