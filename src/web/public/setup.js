/**
 * DollhouseMCP Console — Setup Tab
 *
 * OS detection, platform tab switching, install method toggle,
 * auto-install via API, copy-to-clipboard for install configs.
 */

(() => {
  'use strict';

  // ── Config builders ────────────────────────────────────────────────────

  const PKG = '@dollhousemcp/mcp-server';

  /** Build a JSON config block from an npx-style command string */
  function jsonConfig(rootKey, npxCmd) {
    const parts = npxCmd.split(' ');
    const obj = {};
    obj[rootKey] = { dollhousemcp: { command: parts[0], args: parts.slice(1) } };
    return { code: JSON.stringify(obj, null, 2), copyText: JSON.stringify(obj) };
  }

  /** Build configs for a platform that uses JSON (mcpServers or servers) */
  function platformJson(rootKey, version) {
    return {
      npx: jsonConfig(rootKey, `npx -y ${PKG}@latest`),
      global: jsonConfig(rootKey, `npx -y ${PKG}@${version}`),
    };
  }

  /** Build configs for a CLI platform (terminal command + JSON fallback) */
  function platformCli(cli, rootKey, version) {
    return {
      npx: { code: `${cli} mcp add dollhousemcp -- npx -y ${PKG}@latest`, isTerminal: true },
      global: { code: `${cli} mcp add dollhousemcp -- npx -y ${PKG}@${version}`, isTerminal: true },
      npxJson: jsonConfig(rootKey, `npx -y ${PKG}@latest`),
      globalJson: jsonConfig(rootKey, `npx -y ${PKG}@${version}`),
    };
  }

  /** Build all platform configs for a given version */
  function buildConfigs(version) {
    return {
      'claude-desktop': platformJson('mcpServers', version),
      cursor: platformJson('mcpServers', version),
      windsurf: platformJson('mcpServers', version),
      cline: platformJson('mcpServers', version),
      gemini: platformJson('mcpServers', version),
      lmstudio: platformJson('mcpServers', version),
      vscode: platformJson('servers', version),
      'claude-code': platformCli('claude', 'mcpServers', version),
      codex: {
        ...platformCli('codex', 'mcpServers', version),
        npxToml: { code: `[mcp_servers.dollhousemcp]\ncommand = "npx"\nargs = ["-y", "${PKG}@latest"]` },
        globalToml: { code: `[mcp_servers.dollhousemcp]\ncommand = "npx"\nargs = ["-y", "${PKG}@${version}"]` },
      },
    };
  }

  // Start with a placeholder version, update once we fetch from server
  let pinnedVersion = 'latest';
  let configs = buildConfigs(pinnedVersion);

  // ── Current method state ──────────────────────────────────────────────

  let currentMethod = 'npx';

  // ── OS detection ──────────────────────────────────────────────────────

  const detectOS = () => {
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return 'macos';
    if (/Win/i.test(ua)) return 'windows';
    return 'linux';
  };

  // ── Highlight current OS in path lists ────────────────────────────────

  const highlightOSPaths = (os) => {
    const labels = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
    const label = labels[os];
    if (!label) return;

    document.querySelectorAll('.setup-paths li').forEach((li) => {
      const strong = li.querySelector('strong');
      if (strong && strong.textContent.trim().replace(':', '') === label) {
        li.classList.add('is-current');
      }
    });

    document.querySelectorAll('.setup-os-path').forEach((el) => {
      const osPath = el.dataset[os];
      if (osPath) el.textContent = osPath;
    });
  };

  // ── Method toggle ─────────────────────────────────────────────────────

  const initMethodToggle = () => {
    const toggle = document.getElementById('setup-method-toggle');
    const prereq = document.getElementById('setup-pinned-prereq');
    if (!toggle) return;

    const buttons = toggle.querySelectorAll('.setup-method-btn');

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const method = btn.dataset.method;
        if (!method || method === currentMethod) return;

        currentMethod = method;

        buttons.forEach((b) => {
          b.classList.toggle('is-active', b.dataset.method === method);
          b.setAttribute('aria-pressed', b.dataset.method === method ? 'true' : 'false');
        });

        // Show/hide pinned install prereq step
        if (prereq) prereq.hidden = method !== 'global';

        // Update all config snippets
        updateAllConfigs(method);
      });
    });
  };

  /** Rewrite code blocks and copy-text for the selected method */
  const updateAllConfigs = (method) => {
    for (const [platformKey, platformConfigs] of Object.entries(configs)) {
      const panel = document.getElementById('setup-panel-' + platformKey);
      if (!panel) continue;

      const codeBlocks = Array.from(panel.querySelectorAll('.setup-code-block'));
      let blockIdx = 0;

      // Primary (terminal command or JSON config) — first code block
      const primary = platformConfigs[method];
      if (primary && codeBlocks[blockIdx]) {
        updateCodeBlock(codeBlocks[blockIdx], primary);
        blockIdx++;
      }

      // Secondary JSON (e.g., claude-code has terminal + JSON manual config)
      const jsonKey = method + 'Json';
      if (platformConfigs[jsonKey] && codeBlocks[blockIdx]) {
        updateCodeBlock(codeBlocks[blockIdx], platformConfigs[jsonKey]);
        blockIdx++;
      }

      // Tertiary (TOML for Codex)
      const tomlKey = method + 'Toml';
      if (platformConfigs[tomlKey] && codeBlocks[blockIdx]) {
        updateCodeBlock(codeBlocks[blockIdx], platformConfigs[tomlKey]);
      }
    }
  };

  /** Update a single code block's displayed code and copy button */
  const updateCodeBlock = (block, config) => {
    if (!block || !config) return;

    const pre = block.querySelector('pre code');
    const copyBtn = block.querySelector('.setup-copy-btn');

    if (pre) pre.textContent = config.code;
    if (copyBtn) copyBtn.dataset.copyText = config.copyText || config.code;
  };

  // ── Platform tab switching ────────────────────────────────────────────

  const initPlatformTabs = () => {
    const nav = document.getElementById('setup-platforms');
    if (!nav) return;

    const tabs = nav.querySelectorAll('[role="tab"]');
    const container = nav.parentElement;
    const panels = container.querySelectorAll('[role="tabpanel"]');

    const activate = (tab) => {
      const targetId = tab.getAttribute('aria-controls');
      if (!targetId) return;

      tabs.forEach((t) => {
        t.classList.remove('is-active');
        t.setAttribute('aria-selected', 'false');
      });

      panels.forEach((p) => {
        p.classList.remove('is-active');
        p.hidden = true;
      });

      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');

      const panel = container.querySelector('#' + targetId);
      if (panel) {
        panel.classList.add('is-active');
        panel.hidden = false;
      }
    };

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => activate(tab));
    });
  };

  // ── Copy buttons ──────────────────────────────────────────────────────

  const initCopyButtons = () => {
    // Use event delegation so dynamically updated copy-text works
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.setup-copy-btn');
      if (!btn) return;

      const text = btn.dataset.copyText;
      if (!text) return;

      const original = btn.textContent;

      try {
        let copyText = text;
        try {
          const parsed = JSON.parse(text);
          copyText = JSON.stringify(parsed, null, 2);
        } catch {
          // Not JSON — copy as-is
        }

        await navigator.clipboard.writeText(copyText);
        btn.textContent = 'Copied';
        btn.dataset.copied = '';
      } catch {
        btn.textContent = 'Failed';
      }

      setTimeout(() => {
        btn.textContent = original;
        delete btn.dataset.copied;
      }, 1400);
    });
  };

  // ── Install buttons ────────────────────────────────────────────────────

  const initInstallButtons = () => {
    document.querySelectorAll('.setup-install-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const client = btn.dataset.installClient;
        if (!client) return;

        const status = document.querySelector(`[data-install-status="${client}"]`);
        const originalText = btn.textContent;

        btn.disabled = true;
        btn.textContent = 'Installing...';
        btn.classList.add('is-loading');
        if (status) {
          status.textContent = '';
          status.className = 'setup-install-status';
        }

        try {
          const res = await fetch('/api/setup/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client }),
          });

          const data = await res.json();

          if (data.success) {
            btn.textContent = 'Installed';
            btn.classList.remove('is-loading');
            btn.classList.add('is-success');
            if (status) {
              status.textContent = 'Restart the application to activate.';
              status.classList.add('is-success');
            }
          } else {
            throw new Error(data.error || 'Installation failed');
          }
        } catch (err) {
          btn.textContent = originalText;
          btn.disabled = false;
          btn.classList.remove('is-loading');
          if (status) {
            status.textContent = err.message || 'Installation failed. Try the manual config below.';
            status.classList.add('is-error');
          }
        }
      });
    });
  };

  // ── Open config file buttons ───────────────────────────────────────────

  const initOpenButtons = () => {
    document.querySelectorAll('.setup-open-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const client = btn.dataset.openClient;
        if (!client) return;

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Opening...';

        try {
          const res = await fetch('/api/setup/open-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client }),
          });

          const data = await res.json();

          if (data.success) {
            btn.textContent = 'Opened';
            setTimeout(() => {
              btn.textContent = originalText;
              btn.disabled = false;
            }, 2000);
          } else {
            throw new Error(data.error || 'Could not open file');
          }
        } catch (err) {
          btn.textContent = 'Failed';
          setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
          }, 2000);
        }
      });
    });
  };

  // ── Fetch version and update pinned configs ────────────────────────────

  const fetchVersion = async () => {
    try {
      const res = await fetch('/api/setup/version');
      if (!res.ok) return;
      const data = await res.json();

      // Use latest from GitHub if available, otherwise running version
      pinnedVersion = data.latest?.version || data.running?.version || pinnedVersion;
      if (pinnedVersion === 'latest') return;

      // Rebuild configs with real version
      configs = buildConfigs(pinnedVersion);

      // Update prereq section
      const versionLabel = document.getElementById('pinned-version-label');
      if (versionLabel) versionLabel.textContent = `v${pinnedVersion}`;

      // Update global install command
      const globalCmd = document.getElementById('pinned-global-cmd');
      const globalCopy = document.getElementById('pinned-global-copy');
      if (globalCmd) globalCmd.textContent = `npm install -g ${PKG}@${pinnedVersion}`;
      if (globalCopy) globalCopy.dataset.copyText = `npm install -g ${PKG}@${pinnedVersion}`;

      // Update local install command
      const localCmd = document.getElementById('pinned-local-cmd');
      const localCopy = document.getElementById('pinned-local-copy');
      if (localCmd) localCmd.textContent = `mkdir -p ~/mcp-servers && cd ~/mcp-servers\nnpm install ${PKG}@${pinnedVersion}`;
      if (localCopy) localCopy.dataset.copyText = `mkdir -p ~/mcp-servers && cd ~/mcp-servers && npm install ${PKG}@${pinnedVersion}`;

      // If currently showing pinned method, refresh all config snippets
      if (currentMethod === 'global') {
        updateAllConfigs('global');
      }
    } catch {
      // Offline or no API — keep defaults
    }
  };

  // ── Detect existing installations ──────────────────────────────────────

  // Map from detect API client IDs to platform panel IDs
  const clientToPlatform = {
    'claude': 'claude-desktop',
    'claude-code': 'claude-code',
    'cursor': 'cursor',
    'windsurf': 'windsurf',
    'lmstudio': 'lmstudio',
    'gemini-cli': 'gemini',
    'codex': 'codex',
  };

  const fetchDetection = async () => {
    try {
      const res = await fetch('/api/setup/detect');
      if (!res.ok) return;
      const data = await res.json();

      for (const [clientId, info] of Object.entries(data)) {
        const platformId = clientToPlatform[clientId];
        if (!platformId || !info) continue;

        const { installed, currentConfig } = info;

        // Add badge to the platform tab button
        const tabBtn = document.getElementById('setup-tab-' + platformId);
        if (tabBtn && installed) {
          const badge = document.createElement('span');
          badge.className = 'setup-tab-badge';
          badge.textContent = 'installed';
          badge.title = 'DollhouseMCP is already configured for this client';
          tabBtn.appendChild(badge);
        }

        // Add warning to the platform panel
        const panel = document.getElementById('setup-panel-' + platformId);
        if (panel && installed) {
          const notice = document.createElement('div');
          notice.className = 'setup-installed-notice';

          let html = '<strong>DollhouseMCP is already configured for this client.</strong> ';
          html += 'Installing again will overwrite the existing configuration.';

          if (currentConfig) {
            const configStr = JSON.stringify(currentConfig, null, 2);
            html += `<details><summary>Current config</summary><pre><code>${escapeHtml(configStr)}</code></pre></details>`;
          }

          notice.innerHTML = html;
          panel.insertBefore(notice, panel.firstChild);
        }
      }
    } catch {
      // Offline or no API — skip detection
    }
  };

  const escapeHtml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ── Init ──────────────────────────────────────────────────────────────

  const os = detectOS();
  highlightOSPaths(os);
  initMethodToggle();
  initPlatformTabs();
  initCopyButtons();
  initInstallButtons();
  initOpenButtons();
  fetchVersion();
  fetchDetection();
})();
