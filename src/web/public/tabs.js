/**
 * tabs.js — Console tab switching logic (auto-dollhouse#5)
 * Extracted from inline script to comply with CSP script-src 'self'.
 *
 * Instead of wrapping the portfolio in a div (which breaks CSS selectors),
 * this hides/shows the portfolio's existing elements directly.
 */
(function() {
  'use strict';

  var tabs = document.getElementById('console-tabs');
  if (!tabs) return;

  // Portfolio elements to show/hide (all direct children of .site-main except tab panels)
  var portfolioSelectors = [
    '.browse-controls',
    '.results-bar',
    '.elements-grid',
    '.pagination'
  ];

  var permissionsInitialized = false;

  function showPortfolio() {
    portfolioSelectors.forEach(function(sel) {
      var el = document.querySelector(sel);
      if (el) el.style.display = '';
    });
    var permPanel = document.getElementById('tab-permissions');
    if (permPanel) permPanel.hidden = true;
  }

  function showPermissions() {
    portfolioSelectors.forEach(function(sel) {
      var el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    });
    var permPanel = document.getElementById('tab-permissions');
    if (permPanel) permPanel.hidden = false;

    if (!permissionsInitialized) {
      permissionsInitialized = true;
      if (window.DollhouseConsole && window.DollhouseConsole.permissions && window.DollhouseConsole.permissions.init) {
        window.DollhouseConsole.permissions.init();
      }
    }
  }

  tabs.addEventListener('click', function(e) {
    var btn = e.target.closest('.console-tab');
    if (!btn) return;

    // dmcp-sec[DMCP-SEC-004] — Client-side JS: UnicodeValidator unavailable in browser.
    // Using native String.normalize('NFC') which performs the same NFC normalization.
    // Tab values are hardcoded in HTML data-tab attributes, not user input.
    var targetTab = (btn.dataset.tab || '').normalize('NFC');
    tabs.querySelectorAll('.console-tab').forEach(function(t) {
      t.classList.remove('active');
    });
    btn.classList.add('active');

    if (targetTab === 'permissions') {
      showPermissions();
    } else {
      showPortfolio();
    }
  });
})();
