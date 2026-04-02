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

  /** Handle method toggle button click */
  const handleMethodToggle = (btn, buttons) => {
    const method = btn.dataset.method;
    if (!method || method === currentMethod) return;

    currentMethod = method;

    buttons.forEach((b) => {
      b.classList.toggle('is-active', b.dataset.method === method);
      b.setAttribute('aria-pressed', b.dataset.method === method ? 'true' : 'false');
    });

    const prereq = document.getElementById('setup-pinned-prereq');
    const mcpbSection = document.getElementById('setup-mcpb-section');
    if (prereq) prereq.hidden = method !== 'global';
    if (mcpbSection) mcpbSection.hidden = method !== 'global';

    updateAllConfigs(method);
    updateInstallButtonLabels();
    updateDetectionState();
  };

  const initMethodToggle = () => {
    const toggle = document.getElementById('setup-method-toggle');
    if (!toggle) return;

    const buttons = toggle.querySelectorAll('.setup-method-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => handleMethodToggle(btn, buttons));
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

  // ── Update install button labels based on method ────────────────────────

  const updateInstallButtonLabels = () => {
    const isPinned = currentMethod === 'global' && pinnedVersion && pinnedVersion !== 'latest';

    // Update Install buttons
    document.querySelectorAll('.setup-install-btn').forEach((btn) => {
      if (btn.classList.contains('is-success') || btn.classList.contains('is-match')) return;
      btn.textContent = isPinned ? `Install v${pinnedVersion}` : 'Install Now';
    });

    // Update auto-install badges and descriptions
    document.querySelectorAll('.setup-method-badge').forEach((badge) => {
      badge.textContent = isPinned ? 'pinned version' : 'auto-updating';
    });
    document.querySelectorAll('.setup-method-desc').forEach((desc) => {
      if (isPinned) {
        desc.textContent = `Installs DollhouseMCP v${pinnedVersion}. This version will not auto-update.`;
      } else {
        // Restore original text based on which panel it's in
        const panel = desc.closest('.setup-panel');
        if (panel?.id === 'setup-panel-claude-desktop') {
          desc.innerHTML = 'Pulls the latest version of DollhouseMCP on every startup. Uses <code>npx @latest</code> under the hood. Restart Claude Desktop after.';
        } else if (panel?.id === 'setup-panel-claude-code') {
          desc.textContent = 'Adds DollhouseMCP to Claude Code, pulling the latest version on every startup.';
        }
      }
    });
  };

  // ── Install buttons ────────────────────────────────────────────────────

  /** Handle Install Now button click */
  const handleInstallClick = async (btn) => {
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
      const payload = { client };
      if (currentMethod === 'global' && pinnedVersion && pinnedVersion !== 'latest') {
        payload.version = pinnedVersion;
      }

      const res = await fetch('/api/setup/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!data.success) throw new Error(data.error || 'Installation failed');

      btn.textContent = 'Installed';
      btn.classList.remove('is-loading');
      btn.classList.add('is-success');
      if (status) {
        status.textContent = 'Restart the application to activate.';
        status.classList.add('is-success');
      }
      reDetect();
    } catch (err) {
      btn.textContent = originalText;
      btn.disabled = false;
      btn.classList.remove('is-loading');
      if (status) {
        status.textContent = err.message || 'Installation failed. Try the manual config below.';
        status.classList.add('is-error');
      }
    }
  };

  const initInstallButtons = () => {
    document.querySelectorAll('.setup-install-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleInstallClick(btn));
    });
  };

  // ── Open config file buttons ───────────────────────────────────────────

  /** Handle Open config file button click */
  const handleOpenClick = async (btn) => {
    const client = btn.dataset.openClient;
    if (!client) return;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Opening...';

    const resetBtn = () => {
      btn.textContent = originalText;
      btn.disabled = false;
    };

    try {
      const res = await fetch('/api/setup/open-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not open file');

      btn.textContent = 'Opened';
      setTimeout(resetBtn, 2000);
    } catch {
      btn.textContent = 'Failed';
      setTimeout(resetBtn, 2000);
    }
  };

  const initOpenButtons = () => {
    document.querySelectorAll('.setup-open-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleOpenClick(btn));
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

      // Update .mcpb download button version label
      const mcpbVersion = document.getElementById('pinned-mcpb-version');
      if (mcpbVersion) mcpbVersion.textContent = `(v${pinnedVersion})`;

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

  // Stored detection results — keyed by platform panel ID
  let detectedConfigs = {};

  /**
   * Compare the detected config against what the current method would install.
   * Returns true if command + args match (ignoring env vars and extra keys).
   */
  const configsMatch = (platformId, method) => {
    const detected = detectedConfigs[platformId];
    if (!detected?.installed || !detected?.currentConfig) return false;

    const current = detected.currentConfig;

    // Get the generated config for this platform + method
    const platformConfigs = configs[platformId];
    if (!platformConfigs) return false;

    const generated = platformConfigs[method];
    if (!generated || generated.isTerminal) {
      // For terminal-command platforms, compare via the JSON config instead
      const jsonKey = method + 'Json';
      const jsonConfig = platformConfigs[jsonKey];
      if (!jsonConfig) return false;
      return compareJsonConfig(current, jsonConfig);
    }

    return compareJsonConfig(current, generated);
  };

  /** Compare a detected config object against a generated config block.
   *  Matches on command + package reference. Ignores flags like -y and
   *  extra keys like env, type, etc. — those don't change the server version. */
  const compareJsonConfig = (current, generated) => {
    try {
      const genText = generated.copyText || generated.code;
      const genParsed = JSON.parse(genText);
      const genServer = genParsed.mcpServers?.dollhousemcp || genParsed.servers?.dollhousemcp;
      if (!genServer) return false;

      // Command must match
      if (current.command !== genServer.command) return false;

      // Extract the package reference from args (the @dollhousemcp/... part)
      const getPkgRef = (args) => (args || []).find(a => a.includes('@dollhousemcp/'));
      const currentPkg = getPkgRef(current.args);
      const genPkg = getPkgRef(genServer.args);

      return currentPkg === genPkg;
    } catch {
      return false;
    }
  };

  /**
   * Update all detection notices and button states based on current method.
   * Called on init and whenever the method toggle changes.
   */
  const updateDetectionState = () => {
    for (const platformId of Object.values(clientToPlatform)) {
      updatePlatformDetectionState(platformId);
    }
  };

  /** Update notice, badge, and button for a single platform based on detection match */
  const updatePlatformDetectionState = (platformId) => {
    const detected = detectedConfigs[platformId];
    if (!detected?.installed) return;

    const matches = configsMatch(platformId, currentMethod);
    const panel = document.getElementById('setup-panel-' + platformId);
    const tabBtn = document.getElementById('setup-tab-' + platformId);

    updateDetectionNotice(panel?.querySelector('.setup-installed-notice'), matches);
    updateDetectionBadge(tabBtn?.querySelector('.setup-tab-badge'), matches);
    updateDetectionButton(panel?.querySelector('.setup-install-btn'), matches);
  };

  const updateDetectionNotice = (notice, matches) => {
    if (!notice) return;
    notice.className = matches ? 'setup-installed-notice is-match' : 'setup-installed-notice';
    const strong = notice.querySelector('strong');
    const msg = notice.querySelector('.setup-notice-msg');
    if (strong) strong.textContent = matches
      ? 'DollhouseMCP is configured and matches these settings.'
      : 'DollhouseMCP is already configured for this client.';
    if (msg) msg.textContent = matches
      ? 'No changes would be made.'
      : 'Installing will overwrite the existing configuration.';
  };

  const updateDetectionBadge = (badge, matches) => {
    if (!badge) return;
    badge.className = matches ? 'setup-tab-badge is-match' : 'setup-tab-badge';
    badge.textContent = matches ? 'configured' : 'installed';
  };

  const updateDetectionButton = (installBtn, matches) => {
    if (!installBtn || installBtn.classList.contains('is-success')) return;
    if (matches) {
      installBtn.textContent = 'Already configured';
      installBtn.disabled = true;
      installBtn.classList.add('is-match');
    } else {
      const isPinned = currentMethod === 'global' && pinnedVersion && pinnedVersion !== 'latest';
      installBtn.textContent = isPinned ? `Install v${pinnedVersion}` : 'Install Now';
      installBtn.disabled = false;
      installBtn.classList.remove('is-match');
    }
  };

  /** Create a badge element for an installed platform tab */
  const createTabBadge = (tabBtn) => {
    const badge = document.createElement('span');
    badge.className = 'setup-tab-badge';
    badge.textContent = 'installed';
    badge.title = 'DollhouseMCP is already configured for this client';
    tabBtn.appendChild(badge);
  };

  /** Create a notice element for an installed platform panel */
  const createPanelNotice = (panel, currentConfig) => {
    const notice = document.createElement('div');
    notice.className = 'setup-installed-notice';
    let html = '<strong>DollhouseMCP is already configured for this client.</strong> ';
    html += '<span class="setup-notice-msg">Installing will overwrite the existing configuration.</span>';
    if (currentConfig) {
      const configStr = JSON.stringify(currentConfig, null, 2);
      html += `<details><summary>Current config</summary><pre><code>${escapeHtml(configStr)}</code></pre></details>`;
    }
    notice.innerHTML = html;
    panel.insertBefore(notice, panel.firstChild);
  };

  /** Process detection results for a single client */
  const applyDetectionResult = (clientId, info) => {
    const platformId = clientToPlatform[clientId];
    if (!platformId || !info) return;

    detectedConfigs[platformId] = info;
    if (!info.installed) return;

    const tabBtn = document.getElementById('setup-tab-' + platformId);
    if (tabBtn && !tabBtn.querySelector('.setup-tab-badge')) createTabBadge(tabBtn);

    const panel = document.getElementById('setup-panel-' + platformId);
    if (panel && !panel.querySelector('.setup-installed-notice')) createPanelNotice(panel, info.currentConfig);
  };

  const fetchDetection = async () => {
    try {
      const res = await fetch('/api/setup/detect');
      if (!res.ok) return;
      const data = await res.json();

      for (const [clientId, info] of Object.entries(data)) {
        applyDetectionResult(clientId, info);
      }
      updateDetectionState();
    } catch {
      // Offline or no API — skip detection
    }
  };

  /** Re-fetch detection after an install and update state */
  const reDetect = async () => {
    try {
      const res = await fetch('/api/setup/detect');
      if (!res.ok) return;
      const data = await res.json();
      for (const [clientId, info] of Object.entries(data)) {
        applyDetectionResult(clientId, info);
      }
      updateDetectionState();
    } catch { /* offline — skip */ }
  };

  const escapeHtml = (str) => str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

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
