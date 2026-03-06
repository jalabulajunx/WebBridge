#!/usr/bin/env node
/**
 * WebBridge Native Messaging Host
 *
 * Registered as: com.webbridge.host
 * Chrome communicates via: 4-byte little-endian length-prefixed JSON on stdin/stdout
 *
 * Responsibilities:
 *   1. Relay fetch/cookies/health requests from connected MCP servers to Chrome
 *   2. Relay Chrome's responses back to MCP servers
 *   3. Write recording data from Chrome to ~/.webbridge/sites/<site-id>/
 *   4. List configured sites / manage config files
 *
 * MCP servers connect via a Unix socket at ~/.webbridge/bridge.sock (or TCP on Windows).
 * The socket protocol is newline-delimited JSON (no length prefix — simpler for Node streams).
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const net    = require('net');
const crypto = require('crypto');

// ── Paths ─────────────────────────────────────────────────────────────────────

const WEBBRIDGE_DIR   = path.join(os.homedir(), '.webbridge');
const SITES_DIR       = path.join(WEBBRIDGE_DIR, 'sites');
const SOCKET_PATH     = process.platform === 'win32'
  ? '\\\\.\\pipe\\webbridge'
  : path.join(WEBBRIDGE_DIR, 'bridge.sock');
const PID_FILE        = path.join(WEBBRIDGE_DIR, 'host.pid');
const LOG_FILE        = path.join(WEBBRIDGE_DIR, 'host.log');

// Ensure directory structure exists
for (const dir of [WEBBRIDGE_DIR, SITES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ── Logging ───────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(...args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ')}`;
  logStream.write(line + '\n');
  // Also write to stderr for debugging (Chrome ignores stderr from native hosts)
  process.stderr.write(line + '\n');
}

// ── Native Messaging Protocol ─────────────────────────────────────────────────
// Chrome wraps each message with a 4-byte LE uint32 length prefix.

let nativeReadBuf = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  nativeReadBuf = Buffer.concat([nativeReadBuf, chunk]);
  while (nativeReadBuf.length >= 4) {
    const msgLen = nativeReadBuf.readUInt32LE(0);
    if (nativeReadBuf.length < 4 + msgLen) break;
    const msgBuf = nativeReadBuf.slice(4, 4 + msgLen);
    nativeReadBuf = nativeReadBuf.slice(4 + msgLen);
    let msg;
    try { msg = JSON.parse(msgBuf.toString('utf8')); } catch (e) {
      log('ERROR: malformed JSON from Chrome:', e.message);
      continue;
    }
    handleFromChrome(msg);
  }
});

function sendToChrome(msg) {
  const json = JSON.stringify(msg);
  const buf  = Buffer.from(json, 'utf8');
  const len  = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([len, buf]));
}

// ── In-flight request tracking ────────────────────────────────────────────────
// Maps request IDs from MCP server sockets to the socket that sent them,
// so responses from Chrome can be routed back to the right client.
const inflightRequests = new Map(); // id → socket

// ── From Chrome → Handle ──────────────────────────────────────────────────────

function handleFromChrome(msg) {
  log('← Chrome:', msg.type || msg.id, JSON.stringify(msg).slice(0, 120));

  // Recording data: save to disk
  if (msg.type === 'save_recording') {
    saveRecording(msg);
    return;
  }

  // Responses to MCP-initiated requests: route back to socket
  if (msg.type === 'fetch_response' || msg.type === 'cookies_response' || msg.type === 'health_response') {
    const sock = inflightRequests.get(msg.id);
    if (sock && !sock.destroyed) {
      sockSend(sock, msg);
    } else {
      log('WARN: no socket for response id:', msg.id);
    }
    inflightRequests.delete(msg.id);
    return;
  }

  // List sites response
  if (msg.type === 'list_sites_response' || (msg.id && msg.id.startsWith('ls_'))) {
    const sock = inflightRequests.get(msg.id);
    if (sock && !sock.destroyed) sockSend(sock, msg);
    inflightRequests.delete(msg.id);
    return;
  }

  // Generic callback routing
  if (msg.id) {
    const sock = inflightRequests.get(msg.id);
    if (sock && !sock.destroyed) {
      sockSend(sock, msg);
      inflightRequests.delete(msg.id);
    }
  }
}

// ── Recording Save ────────────────────────────────────────────────────────────

function saveRecording(msg) {
  try {
    const { siteId, recordingName, recording } = msg;
    const siteDir = path.join(SITES_DIR, siteId);
    const recordingsDir = path.join(siteDir, 'recordings');

    for (const dir of [siteDir, recordingsDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Save recording
    const recFile = path.join(recordingsDir, `${recordingName}.json`);
    fs.writeFileSync(recFile, JSON.stringify(recording, null, 2), { encoding: 'utf8', mode: 0o600 });
    log(`Saved recording: ${recFile} (${recording.requestCount} requests)`);

    // Update or create config.json
    const configFile = path.join(siteDir, 'config.json');
    let config = {};
    if (fs.existsSync(configFile)) {
      try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
    }
    config.siteId     = siteId;
    config.domain     = recording.domain;
    config.origin     = recording.origin;
    config.authStrategy = recording.authStrategy;
    config.updatedAt  = new Date().toISOString();
    if (!config.createdAt) config.createdAt = config.updatedAt;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    log(`Updated config: ${configFile}`);

  } catch (e) {
    log('ERROR saving recording:', e.message);
  }
}

// ── From MCP Socket → Handle ──────────────────────────────────────────────────

function handleFromSocket(msg, sock) {
  log('← Socket:', msg.type, msg.id, JSON.stringify(msg).slice(0, 120));

  switch (msg.type) {

    // Proxy a fetch through Chrome
    case 'fetch_request':
    case 'cookies_request':
    case 'health_request': {
      inflightRequests.set(msg.id, sock);
      sendToChrome(msg);
      break;
    }

    // List configured sites (read directly from disk)
    case 'list_sites': {
      const sites = listSites();
      sockSend(sock, { id: msg.id, type: 'list_sites_response', sites });
      break;
    }

    // Read a site's recordings for the CoWork plugin
    case 'read_recordings': {
      const { siteId } = msg;
      try {
        const result = readSiteRecordings(siteId);
        sockSend(sock, { id: msg.id, type: 'read_recordings_response', ...result });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'read_recordings_response', error: e.message });
      }
      break;
    }

    // Write generated server files
    case 'write_server': {
      const { siteId, files } = msg;
      try {
        writeGeneratedServer(siteId, files);
        sockSend(sock, { id: msg.id, type: 'write_server_response', success: true });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'write_server_response', success: false, error: e.message });
      }
      break;
    }

    // Write tools.json after generation
    case 'write_tools': {
      const { siteId, tools } = msg;
      try {
        const toolsFile = path.join(SITES_DIR, siteId, 'tools.json');
        fs.writeFileSync(toolsFile, JSON.stringify(tools, null, 2), { encoding: 'utf8', mode: 0o600 });
        sockSend(sock, { id: msg.id, type: 'write_tools_response', success: true });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'write_tools_response', success: false, error: e.message });
      }
      break;
    }

    // Update auth strategy in config
    case 'set_auth_strategy': {
      const { siteId, authStrategy } = msg;
      try {
        const configFile = path.join(SITES_DIR, siteId, 'config.json');
        let config = {};
        if (fs.existsSync(configFile)) {
          try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
        }
        config.authStrategy = authStrategy;
        config.updatedAt = new Date().toISOString();
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
        sockSend(sock, { id: msg.id, type: 'set_auth_strategy_response', success: true });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'set_auth_strategy_response', success: false, error: e.message });
      }
      break;
    }

    // Remove a single tool from tools.json (Phase 5: per-tool management)
    case 'remove_tool': {
      const { siteId, toolName } = msg;
      try {
        const toolsFile = path.join(SITES_DIR, siteId, 'tools.json');
        if (!fs.existsSync(toolsFile)) {
          sockSend(sock, { id: msg.id, type: 'remove_tool_response', success: false, error: 'tools.json not found' });
          break;
        }
        let tools = JSON.parse(fs.readFileSync(toolsFile, 'utf8'));
        const before = tools.length;
        tools = tools.filter((t) => t.name !== toolName);
        fs.writeFileSync(toolsFile, JSON.stringify(tools, null, 2), { encoding: 'utf8', mode: 0o600 });
        log(`Removed tool "${toolName}" from ${siteId} (${before} → ${tools.length})`);
        sockSend(sock, { id: msg.id, type: 'remove_tool_response', success: true, remaining: tools.length });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'remove_tool_response', success: false, error: e.message });
      }
      break;
    }

    // Return full tools array for a site (Phase 5: popup tools list)
    case 'list_site_tools': {
      const { siteId } = msg;
      try {
        const toolsFile = path.join(SITES_DIR, siteId, 'tools.json');
        const tools = fs.existsSync(toolsFile)
          ? JSON.parse(fs.readFileSync(toolsFile, 'utf8'))
          : [];
        sockSend(sock, { id: msg.id, type: 'list_site_tools_response', tools });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'list_site_tools_response', tools: [], error: e.message });
      }
      break;
    }

    // Persist background-tab auto-reopen preference per domain (Phase 5: bg tab lifecycle)
    case 'set_bg_tab_config': {
      const { siteId, domain, autoReopen } = msg;
      try {
        const configFile = path.join(SITES_DIR, siteId, 'config.json');
        let config = {};
        if (fs.existsSync(configFile)) {
          try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
        }
        if (!config.bgTab) config.bgTab = {};
        config.bgTab.domain     = domain;
        config.bgTab.autoReopen = autoReopen;
        config.updatedAt = new Date().toISOString();
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
        sockSend(sock, { id: msg.id, type: 'set_bg_tab_config_response', success: true });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'set_bg_tab_config_response', success: false, error: e.message });
      }
      break;
    }

    // Read latest recording timestamps vs tools.json mtime (Phase 5: re-record diff)
    case 'recording_diff': {
      const { siteId } = msg;
      try {
        const siteDir      = path.join(SITES_DIR, siteId);
        const recordingsDir = path.join(siteDir, 'recordings');
        const toolsFile    = path.join(siteDir, 'tools.json');
        const serverFile   = path.join(siteDir, 'server', 'index.js');

        const toolsMtime   = fs.existsSync(toolsFile)  ? fs.statSync(toolsFile).mtimeMs  : 0;
        const serverMtime  = fs.existsSync(serverFile) ? fs.statSync(serverFile).mtimeMs : 0;
        const generatedAt  = Math.max(toolsMtime, serverMtime);

        // Recordings newer than the last generation
        const newRecordings = [];
        if (fs.existsSync(recordingsDir)) {
          for (const f of fs.readdirSync(recordingsDir).filter((n) => n.endsWith('.json'))) {
            const fp = path.join(recordingsDir, f);
            if (fs.statSync(fp).mtimeMs > generatedAt) {
              try {
                const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
                newRecordings.push({ filename: f, recordedAt: data.recordedAt, requestCount: data.requestCount });
              } catch (_) {}
            }
          }
        }

        let existingTools = [];
        try { existingTools = JSON.parse(fs.readFileSync(toolsFile, 'utf8')); } catch (_) {}

        sockSend(sock, {
          id: msg.id, type: 'recording_diff_response',
          generatedAt: generatedAt ? new Date(generatedAt).toISOString() : null,
          newRecordings,
          existingTools,
          hasChanges: newRecordings.length > 0,
        });
      } catch (e) {
        sockSend(sock, { id: msg.id, type: 'recording_diff_response', error: e.message });
      }
      break;
    }

    // Health check (native host itself)
    case 'ping': {
      sockSend(sock, { id: msg.id, type: 'pong', pid: process.pid });
      break;
    }

    default:
      log('WARN: unknown message type from socket:', msg.type);
      sockSend(sock, { id: msg.id, error: `Unknown message type: ${msg.type}` });
  }
}

// ── Filesystem Helpers ────────────────────────────────────────────────────────

function listSites() {
  if (!fs.existsSync(SITES_DIR)) return [];
  return fs.readdirSync(SITES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const siteId = e.name;
      const siteDir = path.join(SITES_DIR, siteId);

      let config = { siteId, domain: siteId.replace(/_/g, '.'), authStrategy: 'cookie' };
      const configFile = path.join(siteDir, 'config.json');
      if (fs.existsSync(configFile)) {
        try { config = { ...config, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch (_) {}
      }

      const recordingsDir = path.join(siteDir, 'recordings');
      const recordingCount = fs.existsSync(recordingsDir)
        ? fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.json')).length
        : 0;

      const toolsFile = path.join(siteDir, 'tools.json');
      let toolCount = 0;
      if (fs.existsSync(toolsFile)) {
        try {
          const tools = JSON.parse(fs.readFileSync(toolsFile, 'utf8'));
          toolCount = Array.isArray(tools) ? tools.length : Object.keys(tools).length;
        } catch (_) {}
      }

      return { ...config, recordingCount, toolCount };
    });
}

function readSiteRecordings(siteId) {
  const siteDir = path.join(SITES_DIR, siteId);
  if (!fs.existsSync(siteDir)) throw new Error(`Site not found: ${siteId}`);

  const configFile = path.join(siteDir, 'config.json');
  let config = {};
  if (fs.existsSync(configFile)) {
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
  }

  const recordingsDir = path.join(siteDir, 'recordings');
  const recordings = [];
  if (fs.existsSync(recordingsDir)) {
    for (const f of fs.readdirSync(recordingsDir).filter((n) => n.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(recordingsDir, f), 'utf8'));
        recordings.push({ filename: f, ...data });
      } catch (_) {}
    }
  }

  const toolsFile = path.join(siteDir, 'tools.json');
  let tools = null;
  if (fs.existsSync(toolsFile)) {
    try { tools = JSON.parse(fs.readFileSync(toolsFile, 'utf8')); } catch (_) {}
  }

  return { siteId, config, recordings, tools, siteDir };
}

function writeGeneratedServer(siteId, files) {
  const siteDir = path.join(SITES_DIR, siteId);
  const serverDir = path.join(siteDir, 'server');

  if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 });

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(serverDir, relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, { encoding: 'utf8', mode: 0o600 });
    log(`Wrote: ${fullPath}`);
  }
}

// ── Unix Socket Server ────────────────────────────────────────────────────────

// Remove stale socket file
if (process.platform !== 'win32' && fs.existsSync(SOCKET_PATH)) {
  try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
}

const socketServer = net.createServer((sock) => {
  log('MCP server connected:', sock.remoteAddress || 'socket');

  let sockBuf = '';

  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    sockBuf += chunk;
    // Messages are newline-delimited JSON
    const lines = sockBuf.split('\n');
    sockBuf = lines.pop(); // last element may be incomplete
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch (e) {
        log('ERROR: bad JSON from socket:', e.message, trimmed.slice(0, 100));
        continue;
      }
      handleFromSocket(msg, sock);
    }
  });

  sock.on('error', (e) => log('Socket error:', e.message));
  sock.on('close', () => {
    log('MCP server disconnected');
    // Clean up any inflight requests for this socket
    for (const [id, s] of inflightRequests) {
      if (s === sock) inflightRequests.delete(id);
    }
  });
});

socketServer.listen(SOCKET_PATH, () => {
  log(`Socket listening at: ${SOCKET_PATH}`);
  // Set socket permissions (Unix only)
  if (process.platform !== 'win32') {
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (_) {}
  }
});

socketServer.on('error', (e) => log('Socket server error:', e.message));

// ── Socket Send Helper ────────────────────────────────────────────────────────

function sockSend(sock, msg) {
  if (sock.destroyed) return;
  try {
    sock.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    log('ERROR: sockSend failed:', e.message);
  }
}

// ── PID File ──────────────────────────────────────────────────────────────────

fs.writeFileSync(PID_FILE, String(process.pid), { encoding: 'utf8', mode: 0o600 });

// ── Cleanup on exit ───────────────────────────────────────────────────────────

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGINT',  cleanup);
process.on('SIGTERM', cleanup);
process.on('exit',    () => {
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
  }
});

// Chrome kills the native host when the extension disconnects;
// handle stdin close gracefully
process.stdin.on('end', () => {
  log('Chrome disconnected (stdin closed). Exiting.');
  cleanup();
});

log(`WebBridge native host started. PID=${process.pid} Socket=${SOCKET_PATH}`);
