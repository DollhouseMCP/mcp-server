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

  /** Platform registry — drives config generation AND panel rendering */
  const PLATFORMS = [
    // Claude Desktop & Claude Code panels are handwritten in HTML (unique structure)
    { id: 'claude-desktop', rootKey: 'mcpServers' },
    { id: 'claude-code',    rootKey: 'mcpServers', cli: 'claude' },
    // These panels are generated from this data by renderGeneratedPanels()
    { id: 'cursor',    rootKey: 'mcpServers', installClient: 'cursor',     openClient: 'cursor',     configPath: '<code>.cursor/mcp.json</code> in your project, or <code>~/.cursor/mcp.json</code> for all projects', hint: 'Or configure via Settings &gt; MCP Servers in the Cursor UI.' },
    { id: 'vscode',    rootKey: 'servers',    installClient: 'vscode',     configPath: '<code>.vscode/mcp.json</code> in your workspace', hint: 'VS Code uses <code>"servers"</code>, not <code>"mcpServers"</code>.' },
    { id: 'codex',     rootKey: 'mcpServers', installClient: 'codex',      openClient: 'codex',      cli: 'codex', toml: true, tomlPath: '<code>~/.codex/config.toml</code> (Codex uses TOML, not JSON)' },
    { id: 'gemini',    rootKey: 'mcpServers', installClient: 'gemini-cli', openClient: 'gemini-cli', cli: 'gemini', configPath: '<code>~/.gemini/settings.json</code> or <code>.gemini/settings.json</code> in your project' },
    { id: 'windsurf',  rootKey: 'mcpServers', installClient: 'windsurf',   openClient: 'windsurf',   configPath: '<code>~/.codeium/windsurf/mcp_config.json</code>', hint: 'Or click the MCPs icon in the Cascade panel &gt; Configure.' },
    { id: 'cline',     rootKey: 'mcpServers', installClient: 'cline',      configPath: '<code>cline_mcp_settings.json</code> via Cline\'s top nav &gt; Configure &gt; Advanced MCP Settings' },
    { id: 'lmstudio',  rootKey: 'mcpServers', openClient: 'lmstudio',     configPath: '<code>~/.lmstudio/mcp.json</code> (or open via Program tab &gt; Install &gt; Edit mcp.json)', hint: 'Restart LM Studio after saving.' },
  ];

  /** Build a JSON config block for a given npx command string */
  function jsonConfig(rootKey, npxCmd) {
    const parts = npxCmd.split(' ');
    const obj = {};
    obj[rootKey] = { dollhousemcp: { command: parts[0], args: parts.slice(1) } };
    return { code: JSON.stringify(obj, null, 2), copyText: JSON.stringify(obj) };
  }

  /** Build npx command string for a version tag */
  const npxCmd = (tag) => `npx -y ${PKG}@${tag}`;

  /** Build all platform configs for a given pinned version */
  function buildConfigs(version, channel = 'latest') {
    const ch = channel;
    const result = {};
    for (const { id, rootKey, cli, toml } of PLATFORMS) {
      const entry = {
        npx: cli
          ? { code: `${cli} mcp add dollhousemcp -- ${npxCmd(ch)}`, isTerminal: true }
          : jsonConfig(rootKey, npxCmd(ch)),
        global: cli
          ? { code: `${cli} mcp add dollhousemcp -- ${npxCmd(version)}`, isTerminal: true }
          : jsonConfig(rootKey, npxCmd(version)),
      };
      if (cli) {
        entry.npxJson = jsonConfig(rootKey, npxCmd(ch));
        entry.globalJson = jsonConfig(rootKey, npxCmd(version));
      }
      if (toml) {
        const tomlBlock = (tag) => `[mcp_servers.dollhousemcp]\ncommand = "npx"\nargs = ["-y", "${PKG}@${tag}"]`;
        entry.npxToml = { code: tomlBlock(ch) };
        entry.globalToml = { code: tomlBlock(version) };
      }
      result[id] = entry;
    }
    return result;
  }

  // Start with a placeholder version, update once we fetch from server
  let pinnedVersion = 'latest';
  let currentChannel = 'latest';
  let configs = buildConfigs(pinnedVersion, currentChannel);

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
    if (!toggle) return;

    const buttons = toggle.querySelectorAll('.setup-method-btn');
    // Cache DOM elements queried on every toggle click
    const prereq = document.getElementById('setup-pinned-prereq');
    const mcpbSection = document.getElementById('setup-mcpb-section');
    const channelToggle = document.getElementById('setup-channel-toggle');

    const handleToggle = (btn) => {
      const method = btn.dataset.method;
      if (!method || method === currentMethod) return;

      currentMethod = method;

      buttons.forEach((b) => {
        b.classList.toggle('is-active', b.dataset.method === method);
        b.setAttribute('aria-pressed', b.dataset.method === method ? 'true' : 'false');
      });

      if (prereq) prereq.hidden = method !== 'global';
      if (mcpbSection) mcpbSection.hidden = method !== 'global';
      if (channelToggle) channelToggle.hidden = method === 'global';

      updateAllConfigs(method);
      updateInstallButtonLabels();
      updateDetectionState();
    };

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => handleToggle(btn));
    });

    // Sync initial visibility — if the browser restored a non-default
    // active button (e.g. pinned was selected before reload), apply
    // the hidden state now without waiting for a click.
    if (channelToggle) channelToggle.hidden = currentMethod === 'global';
  };

  // ── Channel selector ──────────────────────────────────────────────────

  /** User-facing descriptions for each release channel, shown below the selector. */
  const CHANNEL_HINTS = {
    latest: 'Recommended for most users.',
    rc: 'Preview of the next stable release. May have minor issues.',
    beta: 'Cutting-edge features. May be unstable.',
  };

  const initChannelSelector = () => {
    const select = document.getElementById('setup-channel-select');
    const hint = document.getElementById('setup-channel-hint');
    if (!select) return;

    select.addEventListener('change', () => {
      currentChannel = select.value;
      if (hint) hint.textContent = CHANNEL_HINTS[currentChannel] || '';
      configs = buildConfigs(pinnedVersion, currentChannel);
      updateAllConfigs(currentMethod);
      updateInstallButtonLabels();
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
        t.setAttribute('tabindex', '-1');
      });

      panels.forEach((p) => {
        p.classList.remove('is-active');
        p.hidden = true;
      });

      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      tab.setAttribute('tabindex', '0');

      const panel = container.querySelector('#' + targetId);
      if (panel) {
        panel.classList.add('is-active');
        panel.hidden = false;
      }
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => activate(tab));
      tab.setAttribute('tabindex', tab.classList.contains('is-active') ? '0' : '-1');
    });

    // Keyboard navigation: arrow keys cycle through platform tabs
    nav.addEventListener('keydown', (e) => {
      const tabArr = Array.from(tabs);
      const current = tabArr.findIndex(t => t.classList.contains('is-active'));
      let next = -1;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        next = (current + 1) % tabArr.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        next = (current - 1 + tabArr.length) % tabArr.length;
      } else if (e.key === 'Home') {
        next = 0;
      } else if (e.key === 'End') {
        next = tabArr.length - 1;
      }

      if (next >= 0) {
        e.preventDefault();
        activate(tabArr[next]);
        tabArr[next].focus();
      }
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
    const channelLabel = currentChannel === 'latest' ? '' : ` (${currentChannel})`;
    document.querySelectorAll('.setup-install-btn').forEach((btn) => {
      if (btn.classList.contains('is-success') || btn.classList.contains('is-match')) return;
      btn.textContent = isPinned ? `Configure v${pinnedVersion}` : `Configure Now${channelLabel}`;
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

  /** Handle Configure Now button click */
  const handleInstallClick = async (btn) => {
    const client = btn.dataset.installClient;
    if (!client) return;

    const status = document.querySelector(`[data-install-status="${client}"]`);
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Configuring...';
    btn.classList.add('is-loading');
    if (status) {
      status.textContent = '';
      status.className = 'setup-install-status';
    }

    try {
      const payload = { client };
      if (currentMethod === 'global' && pinnedVersion && pinnedVersion !== 'latest') {
        payload.version = pinnedVersion;
      } else if (currentChannel !== 'latest') {
        payload.channel = currentChannel;
      }

      const res = await DollhouseAuth.apiFetch('/api/setup/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!data.success) throw new Error(data.error || 'Installation failed');

      btn.textContent = 'Verifying...';

      // Verify the install by re-detecting — confirms config was written
      await fetchDetection();
      const verified = detectedConfigs[clientToPlatformReverse[client]]?.installed;

      btn.textContent = 'Installed';
      btn.classList.remove('is-loading');
      btn.classList.add('is-success');
      if (status) {
        status.textContent = verified
          ? 'Verified — config written. Restart the application to activate.'
          : 'Restart the application to activate.';
        status.classList.add('is-success');
      }

      // Show the completion banner after any successful install
      showCompletionBanner(client);
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

  // ── Completion banner ────────────────────────────────────────────────

  /** Friendly display names for install clients */
  const CLIENT_DISPLAY_NAMES = {
    'claude-desktop': 'Claude Desktop',
    'claude-code': 'Claude Code',
    'cursor': 'Cursor',
    'vscode': 'VS Code',
    'codex': 'Codex',
    'gemini-cli': 'Gemini CLI',
    'windsurf': 'Windsurf',
    'cline': 'Cline',
    'lmstudio': 'LM Studio',
  };

  /** Track which clients have been successfully installed this session */
  const installedClients = [];

  /**
   * Show or update the completion banner after successful install.
   * Tracks all installed clients and updates the banner text to reflect
   * every client that was configured in this session.
   */
  const showCompletionBanner = (client) => {
    const clientName = CLIENT_DISPLAY_NAMES[client] || client;

    // Track this client (avoid duplicates from re-installs)
    if (!installedClients.includes(clientName)) {
      installedClients.push(clientName);
    }

    const clientList = installedClients.length === 1
      ? `<strong>${installedClients[0]}</strong>`
      : installedClients.slice(0, -1).map(c => `<strong>${c}</strong>`).join(', ')
        + ` and <strong>${installedClients.at(-1)}</strong>`;

    const restartList = installedClients.length === 1
      ? `Restart <strong>${installedClients[0]}</strong> to activate DollhouseMCP`
      : `Restart any of your configured clients to activate DollhouseMCP`;

    const configuredWord = installedClients.length === 1 ? 'has' : 'have';

    const bannerHTML = `
      <div class="setup-completion-icon">&#10003;</div>
      <h3>You're all set!</h3>
      <p>${clientList} ${configuredWord} been configured with DollhouseMCP.</p>
      <div class="setup-completion-steps">
        <div class="setup-completion-step">
          <span class="setup-completion-step-num">1</span>
          <span>Close this browser tab</span>
        </div>
        <div class="setup-completion-step">
          <span class="setup-completion-step-num">2</span>
          <span>${restartList}</span>
        </div>
        <div class="setup-completion-step">
          <span class="setup-completion-step-num">3</span>
          <span>Start a conversation and ask: <em>"What DollhouseMCP tools do you have?"</em></span>
        </div>
      </div>
      <p class="setup-completion-terminal-hint">In the terminal, type <code>q</code> to exit the installer.</p>
    `;

    const existing = document.getElementById('setup-completion-banner');
    if (existing) {
      // Update the existing banner with the new client list
      existing.innerHTML = bannerHTML;
      return;
    }

    // First install — create and insert the banner
    const banner = document.createElement('div');
    banner.id = 'setup-completion-banner';
    banner.className = 'setup-completion-banner';
    banner.innerHTML = bannerHTML;

    const setupContent = document.querySelector('.setup-content');
    const heroSection = setupContent?.querySelector('.setup-hero');
    if (setupContent && heroSection) {
      heroSection.after(banner);
    } else if (setupContent) {
      setupContent.prepend(banner);
    }

    banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const initInstallButtons = () => {
    document.querySelectorAll('.setup-install-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleInstallClick(btn));
      // Link button to its status message for accessibility
      const client = btn.dataset.installClient;
      const status = document.querySelector(`[data-install-status="${client}"]`);
      if (status) {
        const statusId = `install-status-${client}`;
        status.id = statusId;
        btn.setAttribute('aria-describedby', statusId);
      }
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
      const res = await DollhouseAuth.apiFetch('/api/setup/open-config', {
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
      const res = await DollhouseAuth.apiFetch('/api/setup/version');
      if (!res.ok) return;
      const data = await res.json();

      // Use latest from GitHub if available, otherwise running version
      pinnedVersion = data.latest?.version || data.running?.version || pinnedVersion;
      if (pinnedVersion === 'latest') return;

      // Rebuild configs with real version and current channel
      configs = buildConfigs(pinnedVersion, currentChannel);

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

  // Map from detect API client IDs to platform panel IDs (and reverse for install verification)
  const clientToPlatform = {
    'claude': 'claude-desktop',
    'claude-code': 'claude-code',
    'cursor': 'cursor',
    'windsurf': 'windsurf',
    'lmstudio': 'lmstudio',
    'gemini-cli': 'gemini',
    'codex': 'codex',
  };

  // Reverse map: installClient ID → platform panel ID (for install verification)
  const clientToPlatformReverse = {};
  for (const [detectId, platformId] of Object.entries(clientToPlatform)) {
    // Also map installClient IDs that differ from detect IDs
    clientToPlatformReverse[detectId] = platformId;
  }

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
      installBtn.textContent = isPinned ? `Configure v${pinnedVersion}` : 'Configure Now';
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

  /** Fetch detection results from API and update all platform states */
  const fetchDetection = async () => {
    try {
      const res = await DollhouseAuth.apiFetch('/api/setup/detect');
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

  const escapeHtml = (str) => str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  // ── Generate platform panels from registry ─────────────────────────────

  /** Build an Open config file button string, or empty if no openClient */
  const openBtnHtml = (openClient) =>
    openClient ? ` <button class="setup-open-btn" type="button" data-open-client="${openClient}">Open config file</button>` : '';

  /** Build the Configure Now + CLI terminal command section */
  const renderInstallSection = (p) => {
    let html = '';
    if (p.installClient) {
      html += '<div class="setup-method setup-method-primary">';
      html += `<div class="setup-install-row"><button class="setup-btn setup-btn-primary setup-install-btn" type="button" data-install-client="${p.installClient}">Configure Now</button>`;
      html += `<span class="setup-install-status" data-install-status="${p.installClient}"></span></div>`;
    }
    if (p.cli) {
      const cmd = `${p.cli} mcp add dollhousemcp -- npx -y ${PKG}@latest`;
      if (!p.installClient) html += '<div class="setup-method setup-method-primary">';
      html += '<h3>Or run in your terminal</h3><p>Run this in your terminal:</p>';
      html += `<div class="setup-code-block"><button class="setup-copy-btn" type="button" data-copy-text="${cmd}" aria-label="Copy command">Copy</button>`;
      html += `<pre><code>${cmd}</code></pre></div>`;
    }
    return html;
  };

  /** Build the JSON config block section */
  const renderJsonSection = (p, hasPrimaryBlock) => {
    if (!p.configPath) return hasPrimaryBlock ? '</div>' : '';

    const config = configs[p.id]?.npx;
    const configCode = config?.code || '';
    const copyText = config?.copyText || configCode;
    let html = '';

    if (hasPrimaryBlock) {
      html += `</div><div class="setup-method"><h3>Or add config manually${openBtnHtml(p.openClient)}</h3>`;
    } else {
      html += `<div class="setup-method setup-method-primary"><h3>Config${openBtnHtml(p.openClient)}</h3>`;
    }
    html += `<p>Add to ${p.configPath}:</p>`;
    html += `<div class="setup-code-block"><button class="setup-copy-btn" type="button" data-copy-text='${copyText}' aria-label="Copy config">Copy</button>`;
    html += `<pre><code>${configCode}</code></pre></div>`;
    if (p.hint) html += `<p class="setup-hint">${p.hint}</p>`;
    html += '</div>';
    return html;
  };

  /** Build the TOML config block section (Codex) */
  const renderTomlSection = (p) => {
    if (!p.tomlPath) return '';
    const tomlConfig = configs[p.id]?.npxToml;
    const tomlCode = tomlConfig?.code || '';
    let html = `<div class="setup-method"><h3>Or add to config${openBtnHtml(p.openClient)}</h3>`;
    html += `<p>Add to ${p.tomlPath}:</p>`;
    html += `<div class="setup-code-block"><button class="setup-copy-btn" type="button" data-copy-text='${tomlCode}' aria-label="Copy config">Copy</button>`;
    html += `<pre><code>${tomlCode}</code></pre></div></div>`;
    return html;
  };

  const renderGeneratedPanels = () => {
    const container = document.getElementById('setup-generated-panels');
    if (!container) return;

    for (const p of PLATFORMS) {
      if (!p.configPath && !p.tomlPath) continue;

      const section = document.createElement('section');
      section.className = 'setup-panel';
      section.setAttribute('role', 'tabpanel');
      section.id = 'setup-panel-' + p.id;
      section.setAttribute('aria-labelledby', 'setup-tab-' + p.id);
      section.hidden = true;

      const hasPrimaryBlock = !!(p.installClient || p.cli);
      section.innerHTML =
        renderInstallSection(p) +
        renderJsonSection(p, hasPrimaryBlock) +
        renderTomlSection(p);

      container.appendChild(section);
    }
  };

  // ── License selector (#1746) ──────────────────────────────────────────

  function formatActivationDate(license) {
    if (license.verifiedAt) return new Date(license.verifiedAt).toLocaleString();
    if (license.attestedAt) return new Date(license.attestedAt).toLocaleString();
    return '—';
  }

  function initLicense() {
    const tiers = document.getElementById('license-tiers');
    if (!tiers) return;

    const tierButtons = tiers.querySelectorAll('.license-tier');
    const details = {
      'agpl': document.getElementById('license-detail-agpl'),
      'free-commercial': document.getElementById('license-detail-free-commercial'),
      'paid-commercial': document.getElementById('license-detail-paid-commercial'),
    };
    const savedBanner = document.getElementById('license-saved');
    const savedText = document.getElementById('license-saved-text');

    function selectTier(tier) {
      // Update button states
      tierButtons.forEach(btn => {
        const selected = btn.dataset.tier === tier;
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-pressed', String(selected));
      });
      // Show/hide detail panels. If the selected tier has an active license,
      // keep the form hidden — showLicenseDetails() will display the details
      // card instead (#1841).
      var hideForm = activeLicense?.status === 'active' && activeLicense?.tier === tier && tier !== 'agpl';
      for (const [key, el] of Object.entries(details)) {
        if (el) el.hidden = key !== tier || hideForm;
      }
      if (hideForm) showLicenseDetails(activeLicense);
      // Hide saved banner when switching
      if (savedBanner) savedBanner.hidden = true;
    }

    // Click handlers for tier buttons
    tierButtons.forEach(btn => {
      btn.addEventListener('click', () => selectTier(btn.dataset.tier));
    });

    // Form submission: Free Commercial
    const freeForm = document.getElementById('license-form-free-commercial');
    if (freeForm) {
      freeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('license-status-free-commercial');
        const data = new FormData(freeForm);
        await submitLicense({
          tier: 'free-commercial',
          email: data.get('email'),
          telemetryAcknowledged: !!data.get('telemetry'),
          attributionAcknowledged: !!data.get('attribution'),
          revenueAttested: !!data.get('attestation'),
        }, status, 'Commercial license activated');
      });
    }

    // Form submission: Paid Commercial
    const paidForm = document.getElementById('license-form-paid-commercial');
    if (paidForm) {
      paidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('license-status-paid-commercial');
        const data = new FormData(paidForm);
        await submitLicense({
          tier: 'paid-commercial',
          email: data.get('email'),
          revenueScale: data.get('revenueScale'),
          companyName: data.get('companyName') || undefined,
          useCase: data.get('useCase') || undefined,
          telemetryAcknowledged: !!data.get('telemetry'),
        }, status, 'Enterprise inquiry sent — our team will reach out within 2 business days');
      });
    }

    const verificationPanel = document.getElementById('license-verification');
    const verifyForm = document.getElementById('license-verify-form');
    const verifyEmailSpan = document.getElementById('license-verify-email');
    const verifyStatus = document.getElementById('license-verify-status');
    const verifyTimer = document.getElementById('license-verify-timer');
    const resendBtn = document.getElementById('license-resend-btn');
    let countdownInterval = null;

    let verificationPollInterval = null;

    function showVerificationUI(email) {
      if (verificationPanel) verificationPanel.hidden = false;
      if (verifyEmailSpan) verifyEmailSpan.textContent = email;
      if (verifyStatus) { verifyStatus.textContent = ''; verifyStatus.className = 'license-form-status'; }
      startCountdown(10 * 60);
      startVerificationPolling();
    }

    function hideVerificationUI() {
      if (verificationPanel) verificationPanel.hidden = true;
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      stopVerificationPolling();
    }

    /** Poll license status every 3 seconds while verification is pending.
     *  When the user clicks the verify link in another tab, this tab
     *  auto-detects the activation and updates without a refresh. */
    function startVerificationPolling() {
      stopVerificationPolling();
      verificationPollInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/setup/license');
          if (!res.ok) return;
          const license = await res.json();
          if (license.status === 'active') {
            handleVerifySuccess(license);
          }
        } catch {
          // Ignore polling errors
        }
      }, 3000);
    }

    function stopVerificationPolling() {
      if (verificationPollInterval) {
        clearInterval(verificationPollInterval);
        verificationPollInterval = null;
      }
    }

    function startCountdown(seconds) {
      if (countdownInterval) clearInterval(countdownInterval);
      let remaining = seconds;
      function update() {
        if (!verifyTimer) return;
        if (remaining <= 0) {
          verifyTimer.textContent = 'Code expired. Click "Resend code" to get a new one.';
          clearInterval(countdownInterval);
          return;
        }
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        verifyTimer.textContent = `Code expires in ${m}:${String(s).padStart(2, '0')}`;
        remaining--;
      }
      update();
      countdownInterval = setInterval(update, 1000);
    }

    async function submitLicense(body, statusEl, successMsg) {
      if (statusEl) {
        statusEl.textContent = '';
        statusEl.className = 'license-form-status';
      }
      try {
        const res = await fetch('/api/setup/license', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) {
          if (statusEl) {
            statusEl.textContent = json.error || 'Failed to save';
            statusEl.className = 'license-form-status is-error';
          }
          return;
        }

        // Commercial tiers: show verification code input
        if (json.verificationRequired) {
          if (statusEl) {
            statusEl.textContent = 'Check your email for a verification code.';
            statusEl.className = 'license-form-status is-success';
          }
          showVerificationUI(body.email);
          return;
        }

        // AGPL or already verified: show success
        if (statusEl) {
          statusEl.textContent = '';
          statusEl.className = 'license-form-status is-success';
        }
        hideVerificationUI();
        if (savedBanner && savedText) {
          savedText.textContent = successMsg;
          savedBanner.hidden = false;
        }
      } catch (err) {
        console.debug('License submission failed:', err);
        if (statusEl) {
          statusEl.textContent = 'Network error — is the server running?';
          statusEl.className = 'license-form-status is-error';
        }
      }
    }

    // Verification form submission
    if (verifyForm) {
      verifyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = new FormData(verifyForm);
        const code = data.get('code');
        if (verifyStatus) { verifyStatus.textContent = ''; verifyStatus.className = 'license-form-status'; }

        try {
          const res = await fetch('/api/setup/license/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          const json = await res.json();
          if (!res.ok) {
            if (verifyStatus) {
              verifyStatus.textContent = json.error || 'Verification failed';
              verifyStatus.className = 'license-form-status is-error';
            }
            return;
          }

          // Verification succeeded
          handleVerifySuccess(json.license);
        } catch (err) {
          console.debug('Verification failed:', err);
          if (verifyStatus) {
            verifyStatus.textContent = 'Network error — is the server running?';
            verifyStatus.className = 'license-form-status is-error';
          }
        }
      });
    }

    // Resend verification code
    if (resendBtn) {
      resendBtn.addEventListener('click', async () => {
        resendBtn.disabled = true;
        if (verifyStatus) { verifyStatus.textContent = 'Sending new code...'; verifyStatus.className = 'license-form-status'; }

        try {
          const res = await fetch('/api/setup/license/resend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const json = await res.json();
          if (res.ok) {
            if (verifyStatus) {
              verifyStatus.textContent = 'New code sent. Check your email.';
              verifyStatus.className = 'license-form-status is-success';
            }
            startCountdown(10 * 60);
          } else if (verifyStatus) {
            verifyStatus.textContent = json.error || 'Failed to resend';
            verifyStatus.className = 'license-form-status is-error';
          }
        } catch (err) {
          console.debug('Resend failed:', err);
          if (verifyStatus) {
            verifyStatus.textContent = 'Network error';
            verifyStatus.className = 'license-form-status is-error';
          }
        }
        setTimeout(() => { resendBtn.disabled = false; }, 5000);
      });
    }

    // Track whether the user has an active commercial license
    let activeLicense = null;

    // AGPL selection: confirm if downgrading from active commercial license
    tierButtons.forEach(btn => {
      if (btn.dataset.tier === 'agpl') {
        btn.addEventListener('click', async () => {
          if (activeLicense?.status === 'active' && activeLicense?.tier !== 'agpl') {
            const tierLabel = activeLicense.tier === 'free-commercial' ? 'Commercial' : 'Enterprise';
            const confirmed = confirm(
              `You have an active ${tierLabel} license. Switching to AGPL will deactivate your ${tierLabel} license.\n\nYou can reactivate your ${tierLabel} license at any time.\n\nAre you sure?`
            );
            if (!confirmed) {
              // Restore the previous tier selection (selectTier handles
              // re-hiding the form when activeLicense is set)
              selectTier(activeLicense.tier);
              return;
            }
          }
          await submitLicense({ tier: 'agpl' }, null, 'AGPL-3.0 license selected');
          activeLicense = null;
          hideLicenseDetails();
        });
      }
    });

    const licenseDetailsPanel = document.getElementById('license-active-details');
    const licenseInfoTable = document.getElementById('license-info-tbody');

    function showLicenseDetails(license) {
      if (!licenseDetailsPanel || !licenseInfoTable) return;
      if (license?.status !== 'active' || license?.tier === 'agpl') {
        licenseDetailsPanel.hidden = true;
        return;
      }

      // Hide the activation form for the active tier — the details panel replaces it (#1841)
      var activeForm = details[license.tier];
      if (activeForm) activeForm.hidden = true;

      const tierLabel = license.tier === 'free-commercial' ? 'Free Commercial' : 'Enterprise';
      const rows = [
        ['License type', tierLabel],
        ['Email', license.email || '—'],
        ['Status', 'Active'],
        ['Activated', formatActivationDate(license)],
        ['Telemetry', license.telemetryRequired ? 'Enabled (license requirement)' : 'Not required'],
      ];
      if (license.tier === 'paid-commercial') {
        if (license.revenueScale) rows.push(['Revenue scale', license.revenueScale]);
        if (license.companyName) rows.push(['Company', license.companyName]);
        if (license.useCase) rows.push(['Use case', license.useCase]);
      }

      licenseInfoTable.innerHTML = rows
        .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
        .join('');
      licenseDetailsPanel.hidden = false;
    }

    function hideLicenseDetails() {
      if (licenseDetailsPanel) licenseDetailsPanel.hidden = true;
    }

    function prefillFreeCommercialForm(license) {
      if (freeForm && license.email) {
        freeForm.querySelector('[name="email"]').value = license.email;
      }
    }

    function prefillEnterpriseForm(license) {
      if (!paidForm) return;
      if (license.email) paidForm.querySelector('[name="email"]').value = license.email;
      if (license.revenueScale) paidForm.querySelector('[name="revenueScale"]').value = license.revenueScale;
      if (license.companyName) paidForm.querySelector('[name="companyName"]').value = license.companyName;
      if (license.useCase) paidForm.querySelector('[name="useCase"]').value = license.useCase;
    }

    function showSavedBanner(license) {
      if (license.tier === 'agpl' || !license.attestedAt) return;
      if (!savedBanner || !savedText) return;
      const tierLabel = license.tier === 'free-commercial' ? 'Commercial' : 'Enterprise';
      savedText.textContent = tierLabel + ' license active';
      savedBanner.hidden = false;
      showLicenseDetails(license);
    }

    // Load saved license on page load
    async function loadSavedLicense() {
      try {
        const res = await fetch('/api/setup/license');
        if (!res.ok) return;
        const license = await res.json();
        if (!license.tier || !details[license.tier]) return;
        selectTier(license.tier);
        if (license.tier === 'free-commercial') prefillFreeCommercialForm(license);
        if (license.tier === 'paid-commercial') prefillEnterpriseForm(license);

        // Show verification UI if license is pending
        if (license.status === 'pending' && license.email) {
          showVerificationUI(license.email);
          return;
        }

        if (license.status === 'active') {
          activeLicense = license;
          showSavedBanner(license);
        }
      } catch (err) {
        // Default AGPL is fine — log for debugging only
        if (typeof console !== 'undefined') console.debug('License load skipped:', err);
      }
    }

    function handleVerifySuccess(license) {
      hideVerificationUI();
      for (const el of Object.values(details)) {
        if (el) el.hidden = true;
      }
      activeLicense = license;
      if (savedBanner && savedText) {
        const tierLabel = license.tier === 'free-commercial' ? 'Commercial' : 'Enterprise';
        savedText.textContent = tierLabel + ' license verified and activated';
        savedBanner.hidden = false;
      }
      showLicenseDetails(license);
    }

    async function handleAutoVerifyFailure(json) {
      const license = await (await fetch('/api/setup/license')).json();
      if (license.status === 'pending' && license.email) {
        showVerificationUI(license.email);
      }
      if (verifyStatus) {
        verifyStatus.textContent = json.error || 'Verification failed';
        verifyStatus.className = 'license-form-status is-error';
      }
    }

    // Auto-verify from email click-through link (#verify=CODE)
    async function checkHashVerification() {
      const hash = globalThis.location.hash;
      const match = /^#verify=(\d{6})$/.exec(hash);
      if (!match) return;

      const code = match[1];
      history.replaceState(null, '', globalThis.location.pathname + '#setup');

      try {
        const res = await fetch('/api/setup/license/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const json = await res.json();
        if (res.ok) {
          handleVerifySuccess(json.license);
        } else {
          await handleAutoVerifyFailure(json);
        }
      } catch (err) {
        console.debug('Auto-verification failed:', err);
      }
    }

    loadSavedLicense();
    checkHashVerification();
  }

  // ── Init ──────────────────────────────────────────────────────────────

  const os = detectOS();
  renderGeneratedPanels();
  highlightOSPaths(os);
  initMethodToggle();
  initChannelSelector();
  initPlatformTabs();
  initCopyButtons();
  initInstallButtons();
  initOpenButtons();
  fetchVersion();
  fetchDetection();
  initLicense();
})();
