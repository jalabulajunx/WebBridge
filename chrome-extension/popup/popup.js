/**
 * WebBridge Popup — Phase 5
 *
 * Expandable site items with:
 *   • "↺ Refresh Session" button — opens/focuses the site tab
 *   • Background tab auto-reopen toggle (for in-context-fetch sites)
 *   • Per-tool management — list + ✕ remove individual tools
 *
 * All heavy lifting (CDP, native messaging) is done in the service worker.
 */

'use strict';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const nativeStatus    = document.getElementById('nativeStatus');
const tabDomain       = document.getElementById('tabDomain');
const btnRecord       = document.getElementById('btnRecord');
const btnStop         = document.getElementById('btnStop');
const recordingBadge  = document.getElementById('recordingBadge');
const requestCount    = document.getElementById('requestCount');
const recordResult    = document.getElementById('recordResult');
const sitesList       = document.getElementById('sitesList');
const reloadRow       = document.getElementById('reloadRow');
const reloadOnRecord  = document.getElementById('reloadOnRecord');
const fullDump        = document.getElementById('fullDump');

// ── State ─────────────────────────────────────────────────────────────────────
let pollInterval = null;
/** Set of expanded site IDs — preserved across list reloads */
const expandedSites = new Set();

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await refreshStatus();
  await loadSites();
  pollInterval = setInterval(refreshStatus, 1500);
}

window.addEventListener('unload', () => {
  if (pollInterval) clearInterval(pollInterval);
});

// ── Status polling ─────────────────────────────────────────────────────────────
async function refreshStatus() {
  const status = await sendBg({ action: 'getStatus' });
  if (!status) return;

  // Native host indicator
  nativeStatus.classList.toggle('connected', !!status.nativeConnected);
  nativeStatus.title = status.nativeConnected
    ? 'Native host connected'
    : 'Native host not connected — install the native host first';

  // Current tab domain
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab  = tabs[0];
  if (tab?.url) {
    try {
      const url = new URL(tab.url);
      tabDomain.textContent = url.hostname;
      tabDomain.classList.add('has-site');
    } catch (_) {
      tabDomain.textContent = 'Unknown page';
      tabDomain.classList.remove('has-site');
    }
  }

  // Recording UI
  if (status.isRecording) {
    btnRecord.classList.add('hidden');
    btnStop.classList.remove('hidden');
    recordingBadge.classList.remove('hidden');
    reloadRow.classList.add('hidden');
    requestCount.textContent = String(status.requestCount || 0);
  } else {
    btnRecord.classList.remove('hidden');
    btnStop.classList.add('hidden');
    recordingBadge.classList.add('hidden');
    reloadRow.classList.remove('hidden');
  }
}

// ── Sites list ─────────────────────────────────────────────────────────────────
async function loadSites() {
  if (!sitesList.querySelector('.site-item')) {
    sitesList.innerHTML = '<div class="loading">Loading…</div>';
  }

  const resp  = await sendBg({ action: 'listSites' });
  const sites = resp?.sites || [];

  if (!sites.length) {
    sitesList.innerHTML = '<div class="empty-state">No sites yet. Record traffic to get started.</div>';
    return;
  }

  sitesList.innerHTML = '';

  for (const site of sites) {
    const item = createSiteItem(site);
    sitesList.appendChild(item);

    // Restore expanded state
    if (expandedSites.has(site.siteId)) {
      item.classList.add('expanded');
      loadSitePanel(item, site);
    }

    // Async health check — update dot without re-rendering the whole list
    sendBg({ action: 'getSiteHealth', domain: site.domain }).then((health) => {
      const dot = item.querySelector('.site-health');
      if (!dot) return;
      if (health?.healthy) {
        dot.className = 'site-health healthy';
        dot.title = `${health.tabCount} tab(s) open — session active`;
      } else {
        dot.className = 'site-health stale';
        dot.title = 'No open tab — click ↺ Refresh Session';
      }
    }).catch(() => {});
  }
}

function createSiteItem(site) {
  const div = document.createElement('div');
  div.className = 'site-item';
  div.dataset.siteId = site.siteId;
  div.dataset.domain = site.domain;
  div.dataset.origin = site.origin || `https://${site.domain}`;
  div.dataset.auth   = site.authStrategy || 'cookie';

  const authClass = {
    bearer: 'auth-bearer',
    apikey: 'auth-apikey',
    cookie: 'auth-cookie',
  }[site.authStrategy] || 'auth-cookie';

  const metaParts = [];
  if (site.recordingCount) metaParts.push(`${site.recordingCount} rec`);
  if (site.toolCount)      metaParts.push(`${site.toolCount} tools`);
  if (site.hasServer)      metaParts.push('server ✓');

  div.innerHTML = `
    <div class="site-header">
      <span class="site-chevron">▶</span>
      <div class="site-info">
        <div class="site-domain">${escHtml(site.domain)}</div>
        ${metaParts.length ? `<div class="site-meta">${escHtml(metaParts.join(' · '))}</div>` : ''}
      </div>
      <div class="site-badges">
        <span class="site-badge ${authClass}">${escHtml(site.authStrategy || 'cookie')}</span>
        <div class="site-health unknown" title="Checking…"></div>
      </div>
    </div>
    <div class="site-panel">
      <!-- filled by loadSitePanel() on expand -->
    </div>
  `;

  // Toggle expand/collapse on header click
  div.querySelector('.site-header').addEventListener('click', () => {
    const isExpanded = div.classList.toggle('expanded');
    if (isExpanded) {
      expandedSites.add(site.siteId);
      loadSitePanel(div, site);
    } else {
      expandedSites.delete(site.siteId);
    }
  });

  return div;
}

// ── Site Panel (expanded) ─────────────────────────────────────────────────────

async function loadSitePanel(itemEl, site) {
  const panel = itemEl.querySelector('.site-panel');
  if (panel.dataset.loaded === 'true') return; // already built

  const isInContextFetch = site.authStrategy === 'in_context_fetch';

  // Read stored bg-tab preference
  const bgTabKey = `wb_bgtab_config_${site.domain}`;
  const stored   = await chrome.storage.local.get(bgTabKey);
  const autoReopen = stored[bgTabKey]?.autoReopen ?? true; // default on for in-context-fetch

  panel.innerHTML = `
    <div class="panel-section-label">Session</div>
    <div class="site-actions">
      <button class="btn btn-sm btn-refresh" data-action="refresh">↺ Refresh Session</button>
    </div>

    ${isInContextFetch ? `
    <div class="bgtab-row">
      <div class="bgtab-label">
        <strong>Background Tab</strong>
        Keep a hidden tab open for always-on auth
      </div>
      <label class="toggle">
        <input type="checkbox" ${autoReopen ? 'checked' : ''} data-action="toggleBgTab">
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
      </label>
    </div>
    ` : ''}

    <div class="tools-label">Tools</div>
    <div class="tools-list">
      <div class="tools-loading">Loading tools…</div>
    </div>
  `;

  // Refresh Session button
  panel.querySelector('[data-action="refresh"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '…';
    const resp = await sendBg({
      action: 'openSiteTab',
      origin: site.origin || `https://${site.domain}`,
      domain: site.domain,
    });
    btn.disabled = false;
    btn.textContent = resp?.focused ? '↺ Focused tab' : '↺ Opened tab';
    setTimeout(() => { btn.textContent = '↺ Refresh Session'; }, 2000);

    // Refresh health dot after a moment
    setTimeout(async () => {
      const health = await sendBg({ action: 'getSiteHealth', domain: site.domain });
      const dot = itemEl.querySelector('.site-health');
      if (dot) {
        dot.className = `site-health ${health?.healthy ? 'healthy' : 'stale'}`;
        dot.title = health?.healthy ? `${health.tabCount} tab(s) open` : 'No open tab';
      }
    }, 1500);
  });

  // Background tab toggle
  const bgToggle = panel.querySelector('[data-action="toggleBgTab"]');
  if (bgToggle) {
    bgToggle.addEventListener('change', async (e) => {
      e.stopPropagation();
      const enabled = e.target.checked;
      await sendBg({
        action: 'setBackgroundTabConfig',
        siteId: site.siteId,
        domain: site.domain,
        autoReopen: enabled,
      });
      if (enabled) {
        // Immediately ensure the tab exists
        await sendBg({ action: 'ensureBackgroundTab', domain: site.domain });
      }
    });
  }

  // Load tools list
  await renderToolsList(panel, site);

  panel.dataset.loaded = 'true';
}

async function renderToolsList(panel, site) {
  const toolsListEl = panel.querySelector('.tools-list');
  if (!toolsListEl) return;

  const resp  = await sendBg({ action: 'listSiteTools', siteId: site.siteId });
  const tools = resp?.tools || [];

  if (!tools.length) {
    toolsListEl.innerHTML = `<div class="tools-empty">No tools generated yet. Run <em>webbridge_read_recordings</em> in Claude.</div>`;
    return;
  }

  toolsListEl.innerHTML = '';
  for (const tool of tools) {
    const row = document.createElement('div');
    row.className = 'tool-item';
    row.innerHTML = `
      <span class="tool-name">${escHtml(tool.name)}</span>
      <span class="tool-desc" title="${escHtml(tool.description || '')}">${escHtml((tool.description || '').slice(0, 60))}</span>
      <button class="tool-remove" title="Remove tool" data-tool="${escHtml(tool.name)}">×</button>
    `;

    row.querySelector('.tool-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      const toolName = e.currentTarget.dataset.tool;
      const confirmed = confirm(`Remove tool "${toolName}" from ${site.siteId}?\n\nThe server must be regenerated to apply changes.`);
      if (!confirmed) return;

      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '…';

      const resp = await sendBg({ action: 'removeTool', siteId: site.siteId, toolName });
      if (resp?.success) {
        row.remove();
        if (!toolsListEl.children.length) {
          toolsListEl.innerHTML = '<div class="tools-empty">No tools. Regenerate with Claude.</div>';
        }
        // Update meta row on header
        const metaEl = document.querySelector(
          `.site-item[data-site-id="${escHtml(site.siteId)}"] .site-meta`
        );
        if (metaEl) {
          const remaining = resp.remaining ?? 0;
          const recs = site.recordingCount || 0;
          metaEl.textContent = [
            recs ? `${recs} rec` : '',
            remaining ? `${remaining} tools` : '',
          ].filter(Boolean).join(' · ');
        }
      } else {
        btn.disabled = false;
        btn.textContent = '×';
        alert(`Failed to remove tool: ${resp?.error || 'unknown error'}`);
      }
    });

    toolsListEl.appendChild(row);
  }
}

// ── Record / Stop ─────────────────────────────────────────────────────────────

btnRecord.addEventListener('click', async () => {
  const skipReload  = !reloadOnRecord.checked;
  const isFullDump  = fullDump.checked;
  btnRecord.disabled = true;
  reloadRow.classList.add('hidden');
  hideResult();

  if (isFullDump) {
    showResult('info', 'Full dump mode — recording ALL requests unfiltered…');
  } else if (!skipReload) {
    // Show brief message before the page reloads (the popup closes on reload)
    showResult('info', 'Reloading page — recording all requests from load…');
  }

  const resp = await sendBg({ action: 'startRecording', skipReload, fullDump: isFullDump });
  btnRecord.disabled = false;

  if (!resp?.success) {
    reloadRow.classList.remove('hidden');
    showResult('error', `Failed to start: ${resp?.error || 'Unknown error'}`);
  } else {
    await refreshStatus();
    if (skipReload && !isFullDump) hideResult();
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  hideResult();

  const resp = await sendBg({ action: 'stopRecording' });
  btnStop.disabled = false;
  await refreshStatus();

  if (!resp?.success) {
    showResult('error', `Failed to stop: ${resp?.error || 'Unknown error'}`);
  } else {
    showResult(
      'success',
      `Saved <strong>${resp.requestCount}</strong> request${resp.requestCount !== 1 ? 's' : ''} ` +
      `for <strong>${escHtml(resp.siteId)}</strong>` +
      (resp.fullDump ? ' · <strong>full dump</strong>' : '') +
      (resp.authStrategy ? ` · auth: ${escHtml(resp.authStrategy)}` : '') +
      (resp.specialPatterns?.hasSSE        ? ' · SSE'       : '') +
      (resp.specialPatterns?.hasWebSocket  ? ' · WebSocket'  : '') +
      (resp.specialPatterns?.hasPollChain  ? ' · Poll chain' : '') +
      `<br>Run <code>webbridge_read_recordings</code> in Claude.`
    );
    // Reload sites; new recording may add a new site
    await loadSites();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function showResult(type, html) {
  recordResult.innerHTML = html;
  recordResult.className = `record-result ${type}`;
  recordResult.classList.remove('hidden');
}

function hideResult() {
  recordResult.classList.add('hidden');
  recordResult.innerHTML = '';
}

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[WebBridge popup]', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init().catch(console.error);
