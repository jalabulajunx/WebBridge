#!/usr/bin/env node
/**
 * WebBridge MCP Server
 *
 * Bridges Claude Desktop/Claude Code to the WebBridge ecosystem:
 *   - Reads captured recordings from ~/.webbridge/sites/<site-id>/
 *   - Writes generated server code on Claude's behalf (with self-validation)
 *   - Tests generated servers by spawning them as child processes
 *   - Installs generated servers as Desktop Extensions or claude_desktop_config entries
 *   - Proxies authenticated fetch requests through the Chrome extension
 *   - Imports HAR files from any browser into WebBridge recordings
 *
 * All site data lives in ~/.webbridge/ which the WebBridge Chrome extension's
 * native host also reads and writes. The MCP server connects to the native host
 * via a Unix socket at ~/.webbridge/bridge.sock.
 *
 * Tools:
 *   webbridge_list_sites           — list configured sites
 *   webbridge_read_recordings      — read captured traffic for a site (or trigger privacy audit for full dumps)
 *   webbridge_write_server         — write generated MCP server files (runs 3 static validators)
 *   webbridge_write_tools_manifest — write tools.json after generation
 *   webbridge_update               — diff new recordings vs existing tools, regenerate only changed
 *   webbridge_test                 — npm install + spawn + test generated server
 *   webbridge_install              — install as Desktop Extension or config entry
 *   webbridge_health_check         — check extension + auth status for a domain
 *   webbridge_fetch                — authenticated fetch through Chrome
 *   webbridge_import_har           — convert browser HAR files into WebBridge recordings
 *
 * DISCLAIMER: Using this tool to interact with websites may violate their Terms
 * of Service or Acceptable Use Policies. Users are solely responsible for ensuring
 * compliance with all applicable terms, laws, and regulations.
 *
 * License: AGPL-3.0-only WITH Commons Clause
 * Copyright (c) 2025 jalabulajunx (https://github.com/jalabulajunx)
 */

'use strict';

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                    = require('zod');
const fs                       = require('fs');
const path                     = require('path');
const os                       = require('os');
const net                      = require('net');
const { execSync, spawn }      = require('child_process');
const crypto                   = require('crypto');

// ── Paths ─────────────────────────────────────────────────────────────────────

const WEBBRIDGE_DIR = path.join(os.homedir(), '.webbridge');
const SITES_DIR     = path.join(WEBBRIDGE_DIR, 'sites');
const SOCKET_PATH   = process.platform === 'win32'
  ? '\\\\.\\pipe\\webbridge'
  : path.join(WEBBRIDGE_DIR, 'bridge.sock');

// ── Native Host Socket Client ─────────────────────────────────────────────────

/**
 * Send a single message to the native host via the Unix socket and wait for
 * a response with a matching id. Connection is opened and closed per call
 * (stateless) — the native host handles concurrent connections fine.
 */
function callNativeHost(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      reject(new Error(
        'WebBridge native host is not running. ' +
        'Make sure the Chrome extension is open and the native host is installed. ' +
        `Socket path: ${SOCKET_PATH}`
      ));
      return;
    }

    const id = msg.id || `mcp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const fullMsg = { ...msg, id };

    const sock = net.createConnection(SOCKET_PATH);
    let buf = '';
    let timer;

    sock.setEncoding('utf8');

    timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Native host timeout after ${timeoutMs}ms for type=${msg.type}`));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(fullMsg) + '\n');
    });

    sock.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let resp;
        try { resp = JSON.parse(trimmed); } catch (_) { continue; }
        if (resp.id === id) {
          clearTimeout(timer);
          sock.destroy();
          if (resp.error) reject(new Error(resp.error));
          else resolve(resp);
        }
      }
    });

    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Native host socket error: ${e.message}`));
    });

    sock.on('close', () => {
      clearTimeout(timer);
    });
  });
}

// Faster health-only ping — does NOT require native host to be running
function isNativeHostRunning() {
  return fs.existsSync(SOCKET_PATH);
}

// ── Progress Ping ─────────────────────────────────────────────────────────────
// Prevents Claude Desktop's 60-second MCP timeout for long operations.

function startProgressPing(server, token, intervalMs = 15000) {
  let seq = 0;
  const id = setInterval(async () => {
    seq++;
    try {
      await server.server.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: seq, total: 100 },
      });
    } catch (_) {}
  }, intervalMs);
  return () => clearInterval(id);
}

// ── Formatting Helpers ────────────────────────────────────────────────────────

function formatRecordingsForClaude(siteId, config, recordings) {
  const lines = [];

  lines.push(`# WebBridge Recordings: ${siteId}`);
  lines.push('');
  lines.push(`**Domain:** ${config.domain || siteId}`);
  lines.push(`**Auth Strategy:** ${config.authStrategy || 'cookie'}`);
  if (config.origin) lines.push(`**Origin:** ${config.origin}`);
  lines.push(`**Recordings:** ${recordings.length}`);
  lines.push('');

  // ── Check for full-dump recordings ────────────────────────────────────────
  const fullDumpRecordings = recordings.filter((r) => r.fullDump);
  const normalRecordings   = recordings.filter((r) => !r.fullDump);

  if (fullDumpRecordings.length > 0) {
    lines.push('## ⚠️ Full Dump Recording(s) Detected');
    lines.push('');
    lines.push(
      `${fullDumpRecordings.length} recording(s) were captured in **Full Dump mode** ` +
      `(unfiltered — every request including analytics, trackers, scripts, and fonts).`
    );
    lines.push('');
    lines.push('**These are NOT suitable for building MCP tools** — they are too noisy.');
    lines.push('');
    lines.push('### What you CAN do with a full dump:');
    lines.push('');
    lines.push('**Privacy & tracking audit** — ask questions like:');
    lines.push('- "What third-party domains does this site contact?"');
    lines.push('- "Which companies are tracking me on this site?"');
    lines.push('- "What data is sent to Google/Facebook/analytics services?"');
    lines.push('- "Are my search terms or form values being sent to third parties?"');
    lines.push('- "What cookies and headers am I sending to each domain?"');
    lines.push('');
    lines.push('**Traffic analysis** — ask questions like:');
    lines.push('- "How many requests does this page make when it loads?"');
    lines.push('- "Which requests are slowest or largest?"');
    lines.push('- "What CDNs or infrastructure providers does this site use?"');
    lines.push('- "Is there any API traffic I could automate?"');
    lines.push('');
    lines.push('**When answering these questions:**');
    lines.push('- Group requests by domain and identify the company/purpose behind each third-party');
    lines.push('- Highlight any requests that contain PII (email, name, user ID) in URL params or body');
    lines.push('- Distinguish first-party data endpoints from third-party analytics/ad trackers');
    lines.push('- Be factual and specific — show the exact URLs and parameter names involved');
    lines.push('');
    lines.push('**If the user also wants MCP tools:** ask them to do a new normal recording');
    lines.push('(uncheck "Full dump") — the filtered recording is better for tool generation.');
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const rec of fullDumpRecordings) {
      lines.push(`---`);
      lines.push(`## Full Dump Recording: ${rec.filename}`);
      lines.push(`Captured: ${rec.recordedAt || 'unknown'} | **${rec.requestCount || 0} total requests (unfiltered)**`);
      lines.push('');

      // Domain summary
      const domainMap = new Map();
      for (const req of (rec.requests || [])) {
        try {
          const host = new URL(req.url).hostname;
          domainMap.set(host, (domainMap.get(host) || 0) + 1);
        } catch (_) {}
      }
      const sortedDomains = [...domainMap.entries()].sort((a, b) => b[1] - a[1]);
      if (sortedDomains.length) {
        lines.push(`### Domains contacted (${sortedDomains.length} unique):`);
        for (const [domain, count] of sortedDomains) {
          lines.push(`- \`${domain}\` — ${count} request(s)`);
        }
        lines.push('');
      }

      // Show ALL requests (they asked for everything)
      if (rec.requests && rec.requests.length > 0) {
        const failedReqs  = rec.requests.filter((r) => r.failed);
        const normalReqs  = rec.requests.filter((r) => !r.failed);

        if (failedReqs.length) {
          lines.push(`### Failed / Blocked Requests (${failedReqs.length})`);
          lines.push('');
          lines.push('These were initiated but never received a valid response.');
          lines.push('Blocked requests often reveal tracker domains the browser silently dropped.');
          lines.push('');
          for (const req of failedReqs) {
            lines.push(`- **${req.method}** \`${req.url}\` — ${req.failureText || 'Failed'}`);
          }
          lines.push('');
        }

        lines.push(`### All Requests (${normalReqs.length}${failedReqs.length ? ` + ${failedReqs.length} failed` : ''})`);
        lines.push('');
        for (const req of normalReqs) {
          const statusStr = req.response?.status ? `${req.response.status}` : 'n/a';
          lines.push(`#### ${req.method} ${req.url}`);
          lines.push(`Type: ${req.resourceType || 'Fetch'} | Status: ${statusStr} | ${req.response?.mimeType || ''}`);

          // Redirect chain
          if (req.redirectChain && req.redirectChain.length > 0) {
            lines.push(`Redirect chain (${req.redirectChain.length} hop${req.redirectChain.length > 1 ? 's' : ''} before final URL):`);
            for (const hop of req.redirectChain) {
              lines.push(`  → ${hop.status} ${hop.url}${hop.location ? ` → ${hop.location}` : ''}`);
            }
          }

          // Request headers — parse cookies into structured list for readability
          const headers = Object.entries(req.requestHeaders || {});
          if (headers.length) {
            lines.push('Request headers:');
            for (const [k, v] of headers) {
              if (k.toLowerCase() === 'cookie') {
                // Parse Cookie header into structured name=value pairs
                const cookies = v.split(';').map((s) => s.trim()).filter(Boolean);
                lines.push(`  Cookie (${cookies.length} values):`);
                for (const c of cookies) {
                  lines.push(`    ${c}`);
                }
              } else {
                lines.push(`  ${k}: ${v}`);
              }
            }
          }

          // Response headers — highlight Set-Cookie
          const respHeaders = Object.entries(req.response?.headers || {});
          const setCookies = respHeaders.filter(([k]) => k.toLowerCase() === 'set-cookie');
          if (setCookies.length) {
            lines.push('Response Set-Cookie:');
            for (const [, v] of setCookies) lines.push(`  ${v}`);
          }

          if (req.postData) {
            let body = req.postData;
            if (body.length > 500) body = body.slice(0, 500) + '... [truncated]';
            lines.push(`Request body: \`\`\`\n${body}\n\`\`\``);
          }

          if (req.responseBody) {
            let body = req.responseBody;
            if (body.length > 1000) body = body.slice(0, 1000) + '\n... [truncated]';
            lines.push(`Response body: \`\`\`\n${body}\n\`\`\``);
          }

          // SSE events
          if (req.sseEvents && req.sseEvents.length > 0) {
            lines.push(`SSE events (${req.sseEvents.length} frames):`);
            for (const ev of req.sseEvents.slice(0, 20)) {
              lines.push(`  [${ev.eventName}] ${ev.data.slice(0, 200)}`);
            }
            if (req.sseEvents.length > 20) lines.push(`  ... and ${req.sseEvents.length - 20} more frames`);
          }

          lines.push('');
        }
      }
    }

    // If there are also normal recordings, continue to process them below
    if (normalRecordings.length === 0) {
      return lines.join('\n');
    }

    lines.push('---');
    lines.push('');
    lines.push(`## Normal (Filtered) Recordings — ${normalRecordings.length} recording(s)`);
    lines.push('');
  }

  // ── Recording quality assessment (filtered recordings only) ───────────────
  // Analyse response types so Claude knows whether this is a JSON API site,
  // an SSR site, or an empty/analytics-only recording before it tries to generate.
  let htmlDataCount = 0;
  let jsonCount = 0;
  let otherApiCount = 0;

  for (const rec of normalRecordings) {
    for (const req of (rec.requests || [])) {
      const mime = req.response?.mimeType || '';
      if (mime.includes('json')) {
        jsonCount++;
      } else if (mime.startsWith('text/html')) {
        // POST→HTML or *.html endpoint with query params → SSR data response
        let isDataHtml = req.method === 'POST';
        if (!isDataHtml && req.url) {
          try {
            const u = new URL(req.url);
            isDataHtml = u.pathname.endsWith('.html') && u.search.length > 1;
          } catch (_) {}
        }
        if (isDataHtml) htmlDataCount++;
      } else if (mime && !mime.startsWith('image/') && !mime.startsWith('font/')) {
        otherApiCount++;
      }
    }
  }

  const hasUsefulData = (jsonCount + htmlDataCount + otherApiCount) > 0;

  if (!hasUsefulData) {
    lines.push('## ⚠️ Recording Quality Warning');
    lines.push('');
    lines.push('**No actionable API data was captured in this recording.**');
    lines.push('All captured requests are analytics pings, static assets, or empty tracking calls.');
    lines.push('');
    lines.push('**Do NOT generate tools from this recording.** Tell the user:');
    lines.push('');
    lines.push('> "The recording didn\'t capture any data endpoints. To get a useful recording:');
    lines.push('> 1. Click ● Record in the WebBridge extension (leave "Reload page when recording starts" checked)');
    lines.push('> 2. Navigate to the specific screen you want to automate — open a lab result, click into a detail view, etc.');
    lines.push('> 3. Perform the exact interactions you want automated');
    lines.push('> 4. Click ■ Stop"');
    lines.push('');
    lines.push('---');
    lines.push('');
  } else if (htmlDataCount > 0 && jsonCount === 0) {
    lines.push('## ℹ️ Server-Side Rendered (SSR) Site Detected');
    lines.push('');
    lines.push(`This site delivers data as HTML, not JSON (${htmlDataCount} HTML data response(s) captured).`);
    lines.push('This is normal for Java/Spring MVC, PHP, and Rails apps.');
    lines.push('');
    lines.push('**When generating tools:**');
    lines.push('- Fetch the HTML endpoints directly (POST to `.html` paths, or GET with data params)');
    lines.push('- Use `extractResponse(response)` — the template already runs `@mozilla/readability`');
    lines.push('  on HTML responses and returns clean readable text automatically');
    lines.push('- Do NOT assume a JSON API exists — work with what was captured');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  for (const rec of normalRecordings) {
    lines.push(`---`);
    lines.push(`## Recording: ${rec.filename}`);
    lines.push(`Captured: ${rec.recordedAt || 'unknown'} | ${rec.requestCount || 0} API requests`);
    if (rec.specialPatterns) {
      const patterns = [];
      if (rec.specialPatterns.hasSSE)       patterns.push('SSE');
      if (rec.specialPatterns.hasWebSocket) patterns.push('WebSocket');
      if (rec.specialPatterns.hasPollChain) patterns.push('Poll Chain');
      if (patterns.length) lines.push(`Special patterns: ${patterns.join(', ')}`);
    }
    lines.push('');

    if (rec.requests && rec.requests.length > 0) {
      lines.push('### Captured Requests');
      lines.push('');
      for (const req of rec.requests) {
        lines.push(`#### ${req.method} ${req.url}`);
        lines.push(`Type: ${req.resourceType || 'Fetch'} | Status: ${req.response?.status ?? 'n/a'}`);

        // Interesting request headers (skip browser boilerplate)
        const skipHeaders = new Set([
          'user-agent', 'accept-encoding', 'accept-language', 'connection',
          'host', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode',
          'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
        ]);
        const interestingHeaders = Object.entries(req.requestHeaders || {})
          .filter(([k]) => !skipHeaders.has(k.toLowerCase()))
          .slice(0, 10);
        if (interestingHeaders.length) {
          lines.push('Request headers:');
          for (const [k, v] of interestingHeaders) {
            lines.push(`  ${k}: ${v}`);
          }
        }

        if (req.postData) {
          let body = req.postData;
          if (body.length > 500) body = body.slice(0, 500) + '... [truncated]';
          lines.push(`Request body: \`\`\`\n${body}\n\`\`\``);
        }

        if (req.response) {
          lines.push(`Response: ${req.response.status} ${req.response.mimeType || ''}`);
          if (req.responseBody) {
            let body = req.responseBody;
            // Try to pretty-print JSON
            try {
              const parsed = JSON.parse(body);
              body = JSON.stringify(parsed, null, 2);
            } catch (_) {}
            if (body.length > 1500) body = body.slice(0, 1500) + '\n... [truncated]';
            lines.push(`Response body: \`\`\`json\n${body}\n\`\`\``);
          }
        }

        // Redirect chain
        if (req.redirectChain && req.redirectChain.length > 0) {
          lines.push(`Redirect chain (${req.redirectChain.length} hop${req.redirectChain.length > 1 ? 's' : ''} before final URL):`);
          for (const hop of req.redirectChain) {
            lines.push(`  → ${hop.status} ${hop.url}${hop.location ? ` → ${hop.location}` : ''}`);
          }
        }

        // SSE frame contents
        if (req.sseEvents && req.sseEvents.length > 0) {
          lines.push(`⚡ SSE endpoint — ${req.sseEvents.length} frame(s) captured:`);
          for (const ev of req.sseEvents.slice(0, 10)) {
            lines.push(`  [${ev.eventName}] ${ev.data.slice(0, 300)}`);
          }
          if (req.sseEvents.length > 10) lines.push(`  ... and ${req.sseEvents.length - 10} more frames`);
        } else if (req.isSSE) {
          lines.push('⚡ This is an SSE streaming endpoint (no frames captured in this recording)');
        }

        if (req.isWebSocket) lines.push('🔌 This is a WebSocket connection');
        if (req.pollChainId) lines.push(`🔄 Poll chain: references ID ${req.pollChainId}`);
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## MANDATORY Code Requirements');
  lines.push('');
  lines.push('**These rules MUST be followed exactly — any deviation causes a runtime crash.**');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### ❌ WRONG — Do NOT do this:');
  lines.push('```js');
  lines.push('// ESM syntax — will crash with ERR_MODULE_NOT_FOUND or SyntaxError');
  lines.push('import { Server } from "@modelcontextprotocol/sdk/server/index.js";');
  lines.push('import http from "http";');
  lines.push('// Wrong bridge — 127.0.0.1:PORT does not exist');
  lines.push('async function bridgeFetch(url) {');
  lines.push('  return new Promise((resolve, reject) => {');
  lines.push('    const req = http.request({ hostname: "127.0.0.1", port: 59210, path: "/fetch" }, ...);');
  lines.push('  });');
  lines.push('}');
  lines.push('// Wrong package.json');
  lines.push('// { "type": "module" }  ← FORBIDDEN');
  lines.push('```');
  lines.push('');
  lines.push('### ✅ RIGHT — Copy this exactly:');
  lines.push('');
  lines.push('**package.json** (no `"type": "module"` — this field must be absent):');
  lines.push('```json');
  lines.push('{');
  lines.push('  "name": "webbridge-SITE_ID",');
  lines.push('  "version": "1.0.0",');
  lines.push('  "main": "index.js",');
  lines.push('  "dependencies": {');
  lines.push('    "@modelcontextprotocol/sdk": "^1.10.0",');
  lines.push('    "zod": "^3.22.0"');
  lines.push('  }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('**index.js top — CommonJS requires and Unix socket bridge (copy verbatim, change SITE_ID/DOMAIN only):**');
  lines.push('```js');
  lines.push("'use strict';");
  lines.push("const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');");
  lines.push("const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');");
  lines.push("const { z }                    = require('zod');");
  lines.push("const net    = require('net');");
  lines.push("const path   = require('path');");
  lines.push("const os     = require('os');");
  lines.push("const crypto = require('crypto');");
  lines.push('');
  lines.push("const SITE_ID       = 'SITE_ID';           // ← replace");
  lines.push("const DOMAIN        = 'www.example.com';   // ← replace");
  lines.push("const AUTH_STRATEGY = 'cookie';");
  lines.push('');
  lines.push('// The bridge is a Unix socket — NOT an HTTP server on localhost');
  lines.push('const SOCKET_PATH = process.platform === "win32"');
  lines.push('  ? "\\\\\\\\.\\\\pipe\\\\webbridge"');
  lines.push('  : path.join(os.homedir(), ".webbridge", "bridge.sock");');
  lines.push('');
  lines.push('function bridgeFetch(requestSpec, timeoutMs = 30000) {');
  lines.push('  return new Promise((resolve, reject) => {');
  lines.push('    const id = `${SITE_ID}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;');
  lines.push('    const sock = net.createConnection(SOCKET_PATH, () => {');
  lines.push('      sock.write(JSON.stringify({');
  lines.push('        type: "fetch_request", id, domain: DOMAIN,');
  lines.push('        authStrategy: AUTH_STRATEGY, requestSpec,');
  lines.push('      }) + "\\n");');
  lines.push('    });');
  lines.push('    let buf = "";');
  lines.push('    const timer = setTimeout(() => { sock.destroy(); reject(new Error("WebBridge timed out")); }, timeoutMs);');
  lines.push('    sock.setEncoding("utf8");');
  lines.push('    sock.on("data", (chunk) => {');
  lines.push('      buf += chunk;');
  lines.push('      const lines = buf.split("\\n"); buf = lines.pop();');
  lines.push('      for (const line of lines) {');
  lines.push('        if (!line.trim()) continue;');
  lines.push('        let resp; try { resp = JSON.parse(line); } catch (_) { continue; }');
  lines.push('        if (resp.id === id) {');
  lines.push('          clearTimeout(timer); sock.destroy();');
  lines.push('          if (resp.error) reject(new Error(resp.error));');
  lines.push('          else if (resp.sessionExpired) reject(new Error(`Session expired on ${DOMAIN}. Log in again in Chrome.`));');
  lines.push('          else resolve(resp.response);');
  lines.push('        }');
  lines.push('      }');
  lines.push('    });');
  lines.push('    sock.on("error", (e) => {');
  lines.push('      clearTimeout(timer);');
  lines.push('      reject(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED"');
  lines.push('        ? "WebBridge native host not running. Open Chrome with the WebBridge extension."');
  lines.push('        : `Bridge socket error: ${e.message}`));');
  lines.push('    });');
  lines.push('  });');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('**Tool pattern (use McpServer + server.tool(), NOT Server + setRequestHandler):**');
  lines.push('```js');
  lines.push('const server = new McpServer({ name: `webbridge-${SITE_ID}`, version: "1.0.0" });');
  lines.push('');
  lines.push('server.tool("tool_name", "Description here.", {');
  lines.push('  param1: z.string().describe("What this param is"),');
  lines.push('  param2: z.number().int().optional().default(0).describe("Optional param"),');
  lines.push('}, async ({ param1, param2 = 0 }) => {');
  lines.push('  try {');
  lines.push('    const resp = await bridgeFetch({');
  lines.push('      url: `https://${DOMAIN}/api/endpoint`,');
  lines.push('      method: "GET",   // or "POST"');
  lines.push('      headers: { "Accept": "application/json" },');
  lines.push('      // body: "key=value"  // for POST with form-encoding');
  lines.push('    });');
  lines.push('    // For JSON responses:');
  lines.push('    const data = JSON.parse(resp.body);');
  lines.push('    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };');
  lines.push('    // For HTML/SSR responses: strip tags yourself or use a simple regex');
  lines.push('  } catch (err) {');
  lines.push('    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };');
  lines.push('  }');
  lines.push('});');
  lines.push('');
  lines.push('async function main() {');
  lines.push('  const transport = new StdioServerTransport();');
  lines.push('  await server.connect(transport);');
  lines.push('}');
  lines.push('main().catch((err) => { process.stderr.write(`[${SITE_ID}] ${err.message}\\n`); process.exit(1); });');
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### Other hard rules:');
  lines.push('');
  lines.push('- **No analytics/logging tools** — if an endpoint is a tracking ping');
  lines.push('  (e.g. contains `action=Log`, `useGdmlLogger`, `/analytics/`, `/beacon/`),');
  lines.push('  skip it entirely. Do NOT create a tool for it.');
  lines.push('- **Error handling in every tool** — every `bridgeFetch()` must be in a try/catch');
  lines.push('  returning `{ content: [{ type: "text", text: \`Error: ${err.message}\` }], isError: true }`.');
  lines.push('- **Only generate tools with clear API evidence** — if the recording is sparse,');
  lines.push('  tell the user which interactions to re-record. Never invent endpoints.');
  lines.push('');
  lines.push('## Generation Steps');
  lines.push('');
  lines.push('1. Identify distinct API operations (one per tool) — skip analytics pings');
  lines.push('2. Name tools with snake_case verbs (e.g. `get_lab_results`, `search_orders`)');
  lines.push('3. Extract input parameters from URL patterns, query strings, and request bodies');
  lines.push('4. For SSR/HTML sites: fetch the same `.html` endpoints with the same POST body,');
  lines.push('   strip tags with a simple regex (`html.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim()`)');
  lines.push('5. Write the server with `webbridge_write_server` — it validates syntax AND checks');
  lines.push('   for common mistakes (wrong bridge, ESM syntax, missing package.json field)');
  lines.push('6. Test with `webbridge_test` — it boots the server and lists tools; fix any errors');
  lines.push('7. Install with `webbridge_install` ONLY after `webbridge_test` passes');
  lines.push('');
  lines.push('Auth is handled automatically by the WebBridge extension — the generated server');
  lines.push('routes requests through the Unix socket bridge, not directly to the site.');

  return lines.join('\n');
}

// ── Server Code Generation Template Helper ────────────────────────────────────

function generateServerTemplate(siteId, config, tools) {
  const serverTemplate = readTemplateFile('server.template.js');
  const pkgTemplate    = readTemplateFile('package.template.json');

  const toolsCode = tools.map((tool) => generateToolCode(tool, config)).join('\n\n');

  const serverCode = serverTemplate
    .replace('__SITE_ID__', siteId)
    .replace('__DOMAIN__', config.domain || siteId)
    .replace('__AUTH_STRATEGY__', config.authStrategy || 'cookie')
    .replace('// __TOOLS_PLACEHOLDER__', toolsCode);

  const pkgCode = pkgTemplate
    .replace('__SITE_ID__', siteId)
    .replace('__VERSION__', '1.0.0');

  return {
    'index.js': serverCode,
    'package.json': pkgCode,
  };
}

function readTemplateFile(filename) {
  // Look for templates relative to this server script
  const templateDirs = [
    path.join(__dirname, '..', '..', 'templates'),
    path.join(__dirname, 'templates'),
  ];
  for (const dir of templateDirs) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  // Fallback: inline minimal template
  return filename === 'package.template.json'
    ? '{"name":"__SITE_ID__-mcp","version":"__VERSION__","private":true,"dependencies":{"@modelcontextprotocol/sdk":"^1.0.0","zod":"^3.22.0"}}'
    : '// Generated WebBridge MCP server for __SITE_ID__\n// __TOOLS_PLACEHOLDER__';
}

function generateToolCode(tool, config) {
  const params = (tool.params || []).map((p) => {
    const zodType = p.required ? `z.string()` : `z.string().optional()`;
    return `    ${p.name}: ${zodType}.describe(${JSON.stringify(p.description || p.name)})`;
  }).join(',\n');

  return `
server.tool(
  '${tool.name}',
  {
${params}
  },
  async (args) => {
    const stopPing = startProgressPing(server, '${tool.name}-' + Date.now());
    try {
      const response = await bridgeFetch({
        method: '${tool.method || 'GET'}',
        url: buildUrl('${tool.urlPattern || '/'}', args),
        headers: ${JSON.stringify(tool.headers || {})},
        body: ${tool.hasBody ? 'buildBody(args)' : 'undefined'},
      });
      const text = extractResponse(response, ${JSON.stringify(tool.extractPath || null)});
      return { content: [{ type: 'text', text }] };
    } finally {
      stopPing();
    }
  }
);`.trim();
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'webbridge',
  version: '1.0.0',
});

// ── Tool: webbridge_list_sites ────────────────────────────────────────────────

server.tool(
  'webbridge_list_sites',
  {},
  async () => {
    // Try native host first (authoritative), fall back to reading disk directly
    let sites = [];

    if (isNativeHostRunning()) {
      try {
        const resp = await callNativeHost({ type: 'list_sites' }, 5000);
        sites = resp.sites || [];
      } catch (_) {}
    }

    // Fall back to direct disk read
    if (!sites.length && fs.existsSync(SITES_DIR)) {
      sites = fs.readdirSync(SITES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const siteId = e.name;
          const siteDir = path.join(SITES_DIR, siteId);
          let config = { siteId, domain: siteId.replace(/_/g, '.'), authStrategy: 'cookie' };
          try {
            const raw = fs.readFileSync(path.join(siteDir, 'config.json'), 'utf8');
            config = { ...config, ...JSON.parse(raw) };
          } catch (_) {}
          const recDir = path.join(siteDir, 'recordings');
          const recCount = fs.existsSync(recDir)
            ? fs.readdirSync(recDir).filter((f) => f.endsWith('.json')).length
            : 0;
          const toolsFile = path.join(siteDir, 'tools.json');
          let toolCount = 0;
          if (fs.existsSync(toolsFile)) {
            try { toolCount = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).length || 0; } catch (_) {}
          }
          const serverDir = path.join(siteDir, 'server');
          const hasServer = fs.existsSync(serverDir) && fs.existsSync(path.join(serverDir, 'index.js'));
          return { ...config, recordingCount: recCount, toolCount, hasServer };
        });
    }

    if (!sites.length) {
      return {
        content: [{
          type: 'text',
          text: [
            '## WebBridge: No Sites Configured',
            '',
            'No sites have been recorded yet.',
            '',
            '**Getting started:**',
            '1. Install the WebBridge Chrome extension (load unpacked from the chrome-extension/ directory)',
            '2. Install the native host: `cd native-host && bash install.sh <extension-id>`',
            '3. Browse to a site you\'re logged into',
            '4. Click the WebBridge icon → Record',
            '5. Perform the actions you want to automate',
            '6. Click Stop',
            '7. Return here and run `webbridge_read_recordings` with the site ID',
          ].join('\n'),
        }],
      };
    }

    const lines = ['## WebBridge: Configured Sites', ''];
    for (const site of sites) {
      const status = site.hasServer ? '✅ Server generated' : site.recordingCount ? '📹 Recorded' : '⬜ Empty';
      lines.push(`### ${site.siteId}`);
      lines.push(`- **Domain:** ${site.domain}`);
      lines.push(`- **Auth:** ${site.authStrategy}`);
      lines.push(`- **Recordings:** ${site.recordingCount}`);
      lines.push(`- **Tools:** ${site.toolCount}`);
      lines.push(`- **Status:** ${status}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('**Next:** Run `webbridge_read_recordings` with a site ID to start generation.');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool: webbridge_read_recordings ──────────────────────────────────────────

server.tool(
  'webbridge_read_recordings',
  {
    site_id: z.string().describe(
      'The site identifier from webbridge_list_sites (e.g. "example_com", "jira_company_com")'
    ),
  },
  async ({ site_id }) => {
    // Try native host first
    if (isNativeHostRunning()) {
      try {
        const resp = await callNativeHost({ type: 'read_recordings', siteId: site_id }, 5000);
        if (resp.recordings) {
          const text = formatRecordingsForClaude(site_id, resp.config, resp.recordings);
          return { content: [{ type: 'text', text }] };
        }
      } catch (_) {}
    }

    // Fall back to direct disk read
    const siteDir = path.join(SITES_DIR, site_id);
    if (!fs.existsSync(siteDir)) {
      return {
        content: [{
          type: 'text',
          text: `Site not found: ${site_id}\n\nRun webbridge_list_sites to see available sites.`,
        }],
      };
    }

    let config = {};
    try { config = JSON.parse(fs.readFileSync(path.join(siteDir, 'config.json'), 'utf8')); } catch (_) {}

    const recordingsDir = path.join(siteDir, 'recordings');
    const recordings = [];
    if (fs.existsSync(recordingsDir)) {
      for (const f of fs.readdirSync(recordingsDir).filter((n) => n.endsWith('.json')).sort()) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(recordingsDir, f), 'utf8'));
          recordings.push({ filename: f, ...data });
        } catch (_) {}
      }
    }

    if (!recordings.length) {
      return {
        content: [{
          type: 'text',
          text: `No recordings found for site: ${site_id}\n\nUse the WebBridge Chrome extension to record traffic first.`,
        }],
      };
    }

    const text = formatRecordingsForClaude(site_id, config, recordings);
    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: webbridge_write_server ──────────────────────────────────────────────

server.tool(
  'webbridge_write_server',
  {
    site_id: z.string().describe('The site identifier (e.g. "example_com")'),
    files: z.record(
      z.string().describe('Relative file path (e.g. "index.js", "package.json")'),
      z.string().describe('Full file content')
    ).describe(
      'Map of relative file paths to file contents. Must include at minimum "index.js" and "package.json". ' +
      'Files are written to ~/.webbridge/sites/<site-id>/server/'
    ),
  },
  async ({ site_id, files }) => {
    // Validate: must include index.js
    if (!files['index.js']) {
      return {
        content: [{
          type: 'text',
          text: 'Error: files must include "index.js" at minimum.',
        }],
      };
    }

    const siteDir = path.join(SITES_DIR, site_id);
    const serverDir = path.join(siteDir, 'server');

    // Try native host (preferred — keeps everything in sync)
    if (isNativeHostRunning()) {
      try {
        await callNativeHost({ type: 'write_server', siteId: site_id, files }, 10000);
      } catch (_) {
        // Fall through to direct write
      }
    }

    // Direct disk write (also runs as fallback)
    if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 });
    const writtenPaths = [];
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(serverDir, relPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, { encoding: 'utf8', mode: 0o600 });
      writtenPaths.push(`  ~/.webbridge/sites/${site_id}/server/${relPath}`);
    }

    // Immediate syntax check — catch ESM/CommonJS mix-ups and typos before the user
    // tries to install, saving a confusing round-trip through Claude Desktop's log viewer.
    const indexPath = path.join(serverDir, 'index.js');
    if (fs.existsSync(indexPath)) {
      try {
        execSync(`node --check "${indexPath}"`, { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (syntaxErr) {
        const errText = (syntaxErr.stderr || syntaxErr.message || '').slice(0, 800);
        const isEsmError = /Cannot use import statement|import .* from|export default|export \{/.test(errText + (files['index.js'] || ''));
        return {
          content: [{
            type: 'text',
            text: [
              `❌ **Syntax error in generated index.js** — the file was written but will not run:`,
              '',
              '```',
              errText,
              '```',
              '',
              isEsmError
                ? [
                    '**Root cause:** The server uses ESM `import`/`export` syntax but must use CommonJS `require()`.',
                    '',
                    'Fix: Replace every `import X from "Y"` with `const X = require("Y")`,',
                    'and remove all `export` statements. Then call `webbridge_write_server` again.',
                  ].join('\n')
                : 'Fix the syntax error above, then call `webbridge_write_server` again.',
            ].join('\n'),
          }],
        };
      }

      // ── Post-syntax static analysis: catch common CoWork mistakes ─────────────

      const indexSrc = files['index.js'] || '';
      const warnings = [];

      // 1. package.json has "type": "module" → will break require()
      const pkgSrc = files['package.json'] || '';
      if (pkgSrc) {
        try {
          const pkg = JSON.parse(pkgSrc);
          if (pkg.type === 'module') {
            warnings.push(
              '❌ **`package.json` has `"type": "module"`** — this MUST be removed.\n' +
              '   CommonJS `require()` calls fail when this field is present.\n' +
              '   Fix: delete the `"type"` field from package.json and call `webbridge_write_server` again.'
            );
          }
        } catch (_) {}
      }

      // 2. Wrong bridge: Claude invented an HTTP/localhost bridge instead of the Unix socket
      const hasHttpBridge = /http\.request|http\.get|axios|fetch\s*\(/.test(indexSrc) &&
                            /127\.0\.0\.1|localhost/.test(indexSrc);
      const hasSocketBridge = /net\.createConnection|bridge\.sock|SOCKET_PATH/.test(indexSrc);
      if (hasHttpBridge && !hasSocketBridge) {
        warnings.push(
          '❌ **Wrong bridge implementation detected.**\n' +
          '   The server appears to use an HTTP client pointed at `127.0.0.1` or `localhost`.\n' +
          '   WebBridge does NOT run an HTTP server. The bridge is a Unix socket at\n' +
          '   `~/.webbridge/bridge.sock`. You must use the `net.createConnection()` pattern\n' +
          '   from the MANDATORY Code Requirements above.\n' +
          '   Fix: Replace your bridgeFetch() with the Unix socket version shown in the instructions,\n' +
          '   then call `webbridge_write_server` again.'
        );
      }

      // 3. Using the old low-level Server + setRequestHandler API instead of McpServer
      const hasLowLevelApi = /setRequestHandler\s*\(|ListToolsRequestSchema|CallToolRequestSchema/.test(indexSrc);
      const hasMcpServer   = /new McpServer\s*\(|server\.tool\s*\(/.test(indexSrc);
      if (hasLowLevelApi && !hasMcpServer) {
        warnings.push(
          '⚠️  **Old low-level MCP API detected** (`setRequestHandler` / `ListToolsRequestSchema`).\n' +
          '   This works but is fragile. Use `McpServer` + `server.tool()` instead.\n' +
          '   The mandatory boilerplate above shows the correct pattern.'
        );
      }

      if (warnings.length > 0) {
        return {
          content: [{
            type: 'text',
            text: [
              `⚠️  **index.js passes syntax check but has critical problems** for **${site_id}**:`,
              '',
              warnings.join('\n\n'),
            ].join('\n'),
          }],
        };
      }
    }

    return {
      content: [{
        type: 'text',
        text: [
          `✅ Server files written and validated for **${site_id}**:`,
          '',
          ...writtenPaths,
          '',
          `Next: Run \`webbridge_test\` with site_id="${site_id}" to install dependencies and verify the server starts.`,
        ].join('\n'),
      }],
    };
  }
);

// ── Tool: webbridge_write_tools_manifest ──────────────────────────────────────

server.tool(
  'webbridge_write_tools_manifest',
  {
    site_id: z.string().describe('The site identifier'),
    tools: z.array(z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.any()).optional(),
    })).describe('Array of tool definitions (name, description, parameters schema)'),
  },
  async ({ site_id, tools }) => {
    const toolsFile = path.join(SITES_DIR, site_id, 'tools.json');

    if (isNativeHostRunning()) {
      try {
        await callNativeHost({ type: 'write_tools', siteId: site_id, tools }, 5000);
        return {
          content: [{
            type: 'text',
            text: `✅ tools.json written for ${site_id} (${tools.length} tool${tools.length !== 1 ? 's' : ''})`,
          }],
        };
      } catch (_) {}
    }

    // Direct write
    const siteDir = path.join(SITES_DIR, site_id);
    if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(toolsFile, JSON.stringify(tools, null, 2), { encoding: 'utf8', mode: 0o600 });
    return {
      content: [{
        type: 'text',
        text: `✅ tools.json written for ${site_id} (${tools.length} tool${tools.length !== 1 ? 's' : ''})`,
      }],
    };
  }
);

// ── Tool: webbridge_update ────────────────────────────────────────────────────
// Phase 5: Re-record / diff flow.
// Reads the existing tools.json + new recordings (recorded after last generation),
// formats a structured diff so Claude can regenerate only the affected tools.

server.tool(
  'webbridge_update',
  {
    site_id: z.string().describe('The site identifier to check for updates'),
  },
  async ({ site_id }) => {
    // Ask native host for the diff metadata (new recordings vs last generation time)
    if (isNativeHostRunning()) {
      try {
        const diff = await callNativeHost({ type: 'recording_diff', siteId: site_id }, 5000);

        if (diff.error) {
          return { content: [{ type: 'text', text: `Error checking diff: ${diff.error}` }] };
        }

        if (!diff.hasChanges) {
          return {
            content: [{
              type: 'text',
              text: [
                `## WebBridge Update: ${site_id}`,
                '',
                '✅ No new recordings since last generation.',
                diff.generatedAt ? `Last generated: ${new Date(diff.generatedAt).toLocaleString()}` : '',
                '',
                `Existing tools (${diff.existingTools.length}):`,
                ...(diff.existingTools.map((t) => `  - **${t.name}**: ${t.description || ''}`)),
                '',
                'If you want to re-record an action, use the WebBridge extension Record button, then run `webbridge_update` again.',
              ].filter((l) => l !== undefined).join('\n'),
            }],
          };
        }

        // There are new recordings — read their full content for Claude to diff
        const siteDir       = path.join(SITES_DIR, site_id);
        const recordingsDir = path.join(siteDir, 'recordings');
        const serverFile    = path.join(siteDir, 'server', 'index.js');
        const toolsMtime    = fs.existsSync(path.join(siteDir, 'tools.json'))
          ? fs.statSync(path.join(siteDir, 'tools.json')).mtimeMs
          : 0;
        const serverMtime   = fs.existsSync(serverFile) ? fs.statSync(serverFile).mtimeMs : 0;
        const generatedAt   = Math.max(toolsMtime, serverMtime);

        // Read new recordings in full
        const newRecordingDetails = [];
        for (const info of diff.newRecordings) {
          try {
            const data = JSON.parse(
              fs.readFileSync(path.join(recordingsDir, info.filename), 'utf8')
            );
            newRecordingDetails.push({ filename: info.filename, ...data });
          } catch (_) {}
        }

        // Read current server index.js for reference
        let currentServer = '';
        if (fs.existsSync(serverFile)) {
          currentServer = fs.readFileSync(serverFile, 'utf8');
          if (currentServer.length > 6000) {
            currentServer = currentServer.slice(0, 6000) + '\n... [truncated]';
          }
        }

        const lines = [
          `## WebBridge Update: ${site_id}`,
          '',
          `**${diff.newRecordings.length} new recording(s)** captured since last generation`,
          diff.generatedAt ? `(last generated: ${new Date(diff.generatedAt).toLocaleString()})` : '',
          '',
          `### Existing Tools (${diff.existingTools.length})`,
          ...diff.existingTools.map((t) => `- **${t.name}**: ${t.description || ''}`),
          '',
          '### New Recordings (captured after last generation)',
          '',
          ...newRecordingDetails.flatMap((rec) => [
            `#### ${rec.filename}`,
            `Recorded: ${rec.recordedAt} | ${rec.requestCount} requests`,
            '',
            ...(rec.requests || []).slice(0, 20).flatMap((req) => {
              const lines2 = [`**${req.method} ${req.url}**`];
              if (req.postData) lines2.push(`Body: \`${req.postData.slice(0, 200)}\``);
              if (req.response) lines2.push(`→ ${req.response.status} ${req.response.mimeType || ''}`);
              if (req.responseBody) {
                let body = req.responseBody;
                try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
                if (body.length > 800) body = body.slice(0, 800) + '... [truncated]';
                lines2.push('```json', body, '```');
              }
              return lines2;
            }),
            '',
          ]),
          '---',
          '',
          '### Current server/index.js (for reference)',
          '```javascript',
          currentServer,
          '```',
          '',
          '---',
          '',
          '## Update Instructions',
          '',
          'Based on the new recordings above:',
          '1. Identify which new recording maps to an existing tool (update) vs a new action (add)',
          '2. If updating: regenerate only the affected `server.tool()` block(s)',
          '3. If adding: write a new `server.tool()` block and add an entry to tools.json',
          '4. Call `webbridge_write_server` with the updated index.js',
          '5. Call `webbridge_write_tools_manifest` with the updated tools array',
          '6. Call `webbridge_test` to verify',
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };

      } catch (e) {
        // Fall through to disk-only path
      }
    }

    // Fallback: native host not running — read disk directly
    const siteDir       = path.join(SITES_DIR, site_id);
    const recordingsDir = path.join(siteDir, 'recordings');
    const toolsFile     = path.join(siteDir, 'tools.json');
    const serverFile    = path.join(siteDir, 'server', 'index.js');

    if (!fs.existsSync(siteDir)) {
      return { content: [{ type: 'text', text: `Site not found: ${site_id}` }] };
    }

    const toolsMtime  = fs.existsSync(toolsFile)  ? fs.statSync(toolsFile).mtimeMs  : 0;
    const serverMtime = fs.existsSync(serverFile) ? fs.statSync(serverFile).mtimeMs : 0;
    const generatedAt = Math.max(toolsMtime, serverMtime);

    let existingTools = [];
    try { existingTools = JSON.parse(fs.readFileSync(toolsFile, 'utf8')); } catch (_) {}

    const newRecordings = [];
    if (fs.existsSync(recordingsDir)) {
      for (const f of fs.readdirSync(recordingsDir).filter((n) => n.endsWith('.json'))) {
        const fp = path.join(recordingsDir, f);
        if (fs.statSync(fp).mtimeMs > generatedAt) {
          try {
            const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
            newRecordings.push({ filename: f, ...data });
          } catch (_) {}
        }
      }
    }

    if (!newRecordings.length) {
      return {
        content: [{
          type: 'text',
          text: `## WebBridge Update: ${site_id}\n\n✅ No new recordings since last generation.\n\nExisting tools: ${existingTools.map((t) => t.name).join(', ') || 'none'}`,
        }],
      };
    }

    const formatted = formatRecordingsForClaude(site_id, {}, newRecordings);
    return {
      content: [{
        type: 'text',
        text: [
          `## WebBridge Update: ${site_id}`,
          `**${newRecordings.length} new recording(s)** since last generation`,
          `Existing tools: ${existingTools.map((t) => `**${t.name}**`).join(', ') || 'none'}`,
          '',
          formatted,
        ].join('\n'),
      }],
    };
  }
);

// ── Tool: webbridge_import_har ────────────────────────────────────────────────
// Convert a browser-exported HAR (HTTP Archive) file into a WebBridge recording.
// Works with HAR files from Chrome DevTools, Firefox, Safari, Fiddler, etc.
// This is the escape-hatch for recordings that were too sparse: export the HAR
// from any browser's DevTools (Network tab → right-click → Save all as HAR),
// then call this tool to import it.

server.tool(
  'webbridge_import_har',
  {
    file_path: z.string().describe(
      'Absolute path to the .har file exported from a browser (Chrome DevTools, Firefox, etc.)'
    ),
    site_id: z.string().optional().describe(
      'Site ID to save the recording under (e.g. "example_com"). ' +
      'If omitted, derived automatically from the first request hostname in the HAR.'
    ),
    filter_domain: z.string().optional().describe(
      'Only include requests for this domain (e.g. "www.example.com"). ' +
      'If omitted, all API-like requests across all domains are included.'
    ),
  },
  async ({ file_path, site_id, filter_domain }) => {
    // Read and parse the HAR
    if (!fs.existsSync(file_path)) {
      return { content: [{ type: 'text', text: `File not found: ${file_path}` }] };
    }

    let har;
    try {
      har = JSON.parse(fs.readFileSync(file_path, 'utf8'));
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to parse HAR file: ${e.message}` }] };
    }

    const entries = har?.log?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return { content: [{ type: 'text', text: 'HAR file contains no entries (log.entries is empty or missing).' }] };
    }

    // ── Convert HAR entries to WebBridge recording format ───────────────────────

    // HAR headers are arrays of {name, value} — flatten to object (last wins on dupe)
    function headersToObject(arr) {
      const obj = {};
      if (Array.isArray(arr)) {
        for (const h of arr) obj[h.name] = h.value;
      }
      return obj;
    }

    // Static-asset URL pattern — same as the recording filter
    function isStaticAsset(url, mime) {
      try {
        const pathname = new URL(url).pathname;
        if (/\.(js|mjs|cjs|css|woff2?|ttf|eot|otf|svg|png|jpe?g|gif|webp|ico|map)(\?|$)/i.test(pathname)) return true;
      } catch (_) {}
      if (
        mime.startsWith('application/javascript') ||
        mime.startsWith('text/javascript') ||
        mime.startsWith('application/x-javascript') ||
        mime.startsWith('text/css') ||
        mime.startsWith('image/') ||
        mime.startsWith('font/') ||
        mime.startsWith('audio/') ||
        mime.startsWith('video/')
      ) return true;
      return false;
    }

    const convertedRequests = [];
    let skipped = 0;
    let primaryDomain = filter_domain || null;

    for (const entry of entries) {
      const req  = entry.request  || {};
      const resp = entry.response || {};

      const url    = req.url    || '';
      const method = req.method || 'GET';
      const status = resp.status || 0;
      const content = resp.content || {};
      const mime   = content.mimeType || resp.mimeType || '';

      // Derive primary domain from first entry if not set
      if (!primaryDomain) {
        try { primaryDomain = new URL(url).hostname; } catch (_) {}
      }

      // Domain filter
      if (filter_domain) {
        try {
          const entryHost = new URL(url).hostname;
          if (entryHost !== filter_domain && !entryHost.endsWith('.' + filter_domain)) {
            skipped++;
            continue;
          }
        } catch (_) {
          skipped++;
          continue;
        }
      }

      // Skip static assets
      if (isStaticAsset(url, mime)) { skipped++; continue; }

      // Skip non-API responses (HTML pages that aren't JSON)
      if (mime.startsWith('text/html') && !mime.includes('json')) {
        // Exception: if it returned JSON-looking content, keep it
        const text = content.text || '';
        if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
          skipped++;
          continue;
        }
      }

      // Skip failed/empty responses
      if (!status || status === 0) { skipped++; continue; }

      const reqHeaders = headersToObject(req.headers || []);
      const respHeaders = headersToObject(resp.headers || []);

      // Redact auth credentials — same policy as recording filter
      if (reqHeaders['Authorization'] || reqHeaders['authorization']) {
        const auth = reqHeaders['Authorization'] || reqHeaders['authorization'];
        reqHeaders['Authorization'] = auth.startsWith('Bearer ') ? 'Bearer [REDACTED]' : '[REDACTED]';
        delete reqHeaders['authorization'];
      }
      // Strip Cookie header — runtime cookies are provided by the extension, not stored
      delete reqHeaders['Cookie'];
      delete reqHeaders['cookie'];

      // Request body
      let postData = null;
      if (req.postData?.text) {
        postData = req.postData.text;
      } else if (req.postData?.params) {
        // URL-encoded form: reconstruct query string
        postData = req.postData.params
          .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value || '')}`)
          .join('&');
      }

      // Response body — HAR may have it base64-encoded
      let responseBody = null;
      if (content.text) {
        responseBody = content.encoding === 'base64'
          ? Buffer.from(content.text, 'base64').toString('utf8')
          : content.text;
        // Truncate very large bodies
        if (responseBody.length > 100000) {
          responseBody = responseBody.slice(0, 100000) + '\n... [truncated by webbridge_import_har]';
        }
      }

      const isSSE = mime === 'text/event-stream';

      convertedRequests.push({
        requestId: `har_${convertedRequests.length}`,
        method,
        url,
        requestHeaders: reqHeaders,
        postData,
        resourceType: entry._resourceType || (method === 'GET' ? 'Fetch' : 'XHR'),
        documentURL: entry.pageref || '',
        capturedAt: entry.startedDateTime || new Date().toISOString(),
        response: {
          status,
          statusText: resp.statusText || '',
          headers: respHeaders,
          mimeType: mime,
          url,
        },
        responseBody,
        isSSE,
        isWebSocket: false,
        pollChainId: null,
      });
    }

    if (convertedRequests.length === 0) {
      return {
        content: [{
          type: 'text',
          text: [
            `No API requests found in the HAR after filtering (${skipped} entries skipped).`,
            '',
            filter_domain
              ? `Domain filter was set to "${filter_domain}" — verify requests in the HAR match this domain.`
              : 'Try specifying filter_domain to limit to a single hostname.',
          ].join('\n'),
        }],
      };
    }

    // Detect auth strategy from imported headers
    let authStrategy = 'cookie';
    for (const r of convertedRequests) {
      const auth = r.requestHeaders?.Authorization || '';
      if (auth.startsWith('Bearer ')) { authStrategy = 'bearer'; break; }
      if (r.requestHeaders?.['X-API-Key'] || r.requestHeaders?.['x-api-key']) { authStrategy = 'apikey'; break; }
    }

    // Derive site_id if not provided
    const domain = primaryDomain || 'unknown';
    const derivedSiteId = site_id || domain.replace(/^www\./, '').replace(/\./g, '_').replace(/[^a-zA-Z0-9_-]/g, '');

    // Build the recording object
    const recording = {
      siteId: derivedSiteId,
      domain,
      origin: `https://${domain}`,
      startUrl: convertedRequests[0]?.url || `https://${domain}`,
      authStrategy,
      specialPatterns: { hasSSE: convertedRequests.some((r) => r.isSSE), hasWebSocket: false, hasPollChain: false },
      recordedAt: new Date().toISOString(),
      requestCount: convertedRequests.length,
      importedFromHar: path.basename(file_path),
      requests: convertedRequests,
    };

    // Save the recording
    const siteDir      = path.join(SITES_DIR, derivedSiteId);
    const recDir       = path.join(siteDir, 'recordings');
    const configFile   = path.join(siteDir, 'config.json');

    if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true, mode: 0o700 });

    // Write/update config.json (preserves existing auth strategy override if present)
    let existingConfig = {};
    if (fs.existsSync(configFile)) {
      try { existingConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
    }
    const newConfig = {
      siteId: derivedSiteId,
      domain,
      origin: `https://${domain}`,
      authStrategy: existingConfig.authStrategy || authStrategy,
      ...existingConfig,
    };
    fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2), 'utf8');

    const recordingName = `recording_${Date.now()}.json`;
    fs.writeFileSync(path.join(recDir, recordingName), JSON.stringify(recording, null, 2), 'utf8');

    return {
      content: [{
        type: 'text',
        text: [
          `## HAR Import Complete`,
          '',
          `**File:** ${path.basename(file_path)}`,
          `**Site ID:** ${derivedSiteId}`,
          `**Domain:** ${domain}`,
          `**Auth strategy:** ${authStrategy}`,
          `**API requests imported:** ${convertedRequests.length}`,
          `**Entries skipped** (static assets, HTML, off-domain): ${skipped}`,
          `**Saved as:** ${recordingName}`,
          '',
          '**Next:** Run `webbridge_read_recordings` with:',
          `  site_id="${derivedSiteId}"`,
          '',
          '**Request summary:**',
          ...convertedRequests.slice(0, 30).map((r) =>
            `  ${r.method} ${r.url} → ${r.response?.status ?? '?'} ${r.response?.mimeType || ''}`
          ),
          convertedRequests.length > 30 ? `  ... and ${convertedRequests.length - 30} more` : '',
        ].filter((l) => l !== undefined).join('\n'),
      }],
    };
  }
);

// ── Tool: webbridge_test ──────────────────────────────────────────────────────

server.tool(
  'webbridge_test',
  {
    site_id: z.string().describe('The site identifier to test'),
    test_inputs: z.record(z.any()).optional().describe(
      'Optional map of tool_name → test arguments. If omitted, Claude should provide realistic ' +
      'test inputs based on the tool descriptions and parameter schemas.'
    ),
    skip_install: z.boolean().optional().describe(
      'Skip npm install (use if already installed). Default: false'
    ),
  },
  async ({ site_id, test_inputs, skip_install }) => {
    const stopPing = startProgressPing(server, `test-${Date.now()}`, 10000);
    try {
      const serverDir = path.join(SITES_DIR, site_id, 'server');

      if (!fs.existsSync(serverDir)) {
        return {
          content: [{
            type: 'text',
            text: `Server directory not found for ${site_id}. Run webbridge_write_server first.`,
          }],
        };
      }

      const indexJs = path.join(serverDir, 'index.js');
      if (!fs.existsSync(indexJs)) {
        return {
          content: [{
            type: 'text',
            text: `index.js not found in ${serverDir}. Run webbridge_write_server first.`,
          }],
        };
      }

      const results = [];

      // Step 1: npm install
      if (!skip_install) {
        results.push('## Step 1: Installing dependencies');
        try {
          const installOut = execSync('npm install --production', {
            cwd: serverDir,
            timeout: 120000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          results.push(`✅ npm install succeeded\n${installOut.slice(0, 300)}`);
        } catch (e) {
          results.push(`❌ npm install failed:\n${e.stderr || e.message}`);
          return { content: [{ type: 'text', text: results.join('\n\n') }] };
        }
      } else {
        results.push('## Step 1: Skipping npm install (skip_install=true)');
      }

      // Step 2: Syntax check
      results.push('\n## Step 2: Syntax check');
      try {
        execSync(`node --check "${indexJs}"`, { timeout: 10000, encoding: 'utf8' });
        results.push('✅ Syntax OK');
      } catch (e) {
        results.push(`❌ Syntax error:\n${e.stderr || e.message}`);
        return { content: [{ type: 'text', text: results.join('\n\n') }] };
      }

      // Step 3: Read tools.json to know what tools exist
      const toolsFile = path.join(SITES_DIR, site_id, 'tools.json');
      let toolDefs = [];
      if (fs.existsSync(toolsFile)) {
        try { toolDefs = JSON.parse(fs.readFileSync(toolsFile, 'utf8')); } catch (_) {}
      }

      // Step 4: Spawn the MCP server and probe it
      results.push('\n## Step 3: Server startup check');
      const startResult = await testServerStartup(indexJs);
      if (startResult.error) {
        results.push(`❌ Server failed to start:\n${startResult.error}`);
      } else {
        results.push(`✅ Server started successfully (${startResult.startupMs}ms)`);
        if (startResult.tools && startResult.tools.length) {
          results.push(`\nRegistered tools (${startResult.tools.length}):`);
          for (const t of startResult.tools) {
            results.push(`  - **${t.name}**: ${t.description || ''}`);
          }
        }
      }

      // Step 5: Summary
      results.push('\n## Summary');
      if (startResult.error) {
        results.push(
          '❌ Server failed. The error and diagnosis are above.\n\n' +
          'Typical fixes:\n' +
          '- **Missing package / MODULE_NOT_FOUND** → check package.json `dependencies`, call `webbridge_test` again\n' +
          '- **ESM import syntax** → rewrite with `require()`, call `webbridge_write_server` then `webbridge_test`\n' +
          '- **Wrong bridge (127.0.0.1)** → replace bridgeFetch() with the Unix socket version, call `webbridge_write_server` then `webbridge_test`\n' +
          '- **Syntax error** → fix the error shown, call `webbridge_write_server` then `webbridge_test`'
        );
      } else {
        results.push(
          `✅ Server is good — ${startResult.tools.length} tool(s) registered in ${startResult.startupMs}ms.\n` +
          'Run `webbridge_install` to package and install it for Claude Desktop.'
        );
      }

      if (test_inputs && toolDefs.length) {
        results.push('\n**Note:** test_inputs were provided but live tool calling requires Claude Desktop. ' +
          'The startup check above confirms the server structure is correct.');
      }

      return { content: [{ type: 'text', text: results.join('\n') }] };

    } finally {
      stopPing();
    }
  }
);

/**
 * Spawns the MCP server process, sends an initialize + tools/list request,
 * reads the response, and shuts down. Returns tool list or error.
 */
function testServerStartup(indexJsPath) {
  return new Promise((resolve) => {
    const start = Date.now();
    let proc;
    let output = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      if (proc) proc.kill();
      resolve({ error: 'Server process timed out after 15 seconds' });
    }, 15000);

    try {
      proc = spawn('node', [indexJsPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (e) {
      clearTimeout(timeout);
      resolve({ error: `Failed to spawn process: ${e.message}` });
      return;
    }

    // MCP initialize handshake
    const initRequest = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'webbridge-test', version: '1.0' },
      },
    }) + '\n';

    const listRequest = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    }) + '\n';

    let stderr = '';
    let initialized = false;
    let tools = [];

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      output += chunk;
      const lines = output.split('\n');
      output = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try { msg = JSON.parse(trimmed); } catch (_) { continue; }

        if (msg.id === 1 && msg.result) {
          // Got initialize response — send tools/list
          initialized = true;
          proc.stdin.write(listRequest);
        }

        if (msg.id === 2 && msg.result) {
          tools = msg.result.tools || [];
          clearTimeout(timeout);
          const startupMs = Date.now() - start;
          proc.kill();
          resolve({ startupMs, tools });
        }

        if (msg.error) {
          clearTimeout(timeout);
          proc.kill();
          resolve({ error: `MCP error: ${JSON.stringify(msg.error)}` });
        }
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timeout);
      resolve({ error: `Process error: ${e.message}` });
    });

    proc.on('exit', (code, signal) => {
      if (!timedOut) {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          // Diagnose common crash patterns so Claude can fix without a manual investigation
          const stderrSnip = stderr.slice(0, 800);
          let diagnosis = '';

          if (/Cannot find package|MODULE_NOT_FOUND/.test(stderrSnip)) {
            const missingPkg = (stderrSnip.match(/Cannot find (?:package|module) '([^']+)'/) || [])[1] || '(unknown)';
            if (/@modelcontextprotocol|zod/.test(missingPkg)) {
              diagnosis = (
                '\n\n**Root cause: missing node_modules.**\n' +
                'The package `' + missingPkg + '` is not installed in the server directory.\n' +
                'This usually means the server was written but `webbridge_test` (which runs npm install)\n' +
                'was never called, OR the package.json is missing the dependency.\n' +
                'Fix: ensure package.json lists the dependency, then call `webbridge_test` again (it will re-run npm install).'
              );
            } else {
              diagnosis = (
                '\n\n**Root cause: missing dependency `' + missingPkg + '`.**\n' +
                'Add it to the `dependencies` field in package.json, then call `webbridge_test` again.'
              );
            }
          } else if (/Cannot use import statement|import .* from/.test(stderrSnip)) {
            diagnosis = (
              '\n\n**Root cause: ESM `import` syntax in a CommonJS context.**\n' +
              'The server uses `import X from "Y"` but must use `const X = require("Y")`.\n' +
              'Fix: rewrite index.js with CommonJS syntax and call `webbridge_write_server` again.'
            );
          } else if (/127\.0\.0\.1|localhost.*ECONNREFUSED/.test(stderrSnip)) {
            diagnosis = (
              '\n\n**Root cause: wrong bridge — server is trying to connect to an HTTP server on localhost.**\n' +
              'WebBridge uses a Unix socket at `~/.webbridge/bridge.sock`, not an HTTP server.\n' +
              'Fix: replace bridgeFetch() with the Unix socket version from the MANDATORY Code Requirements.'
            );
          } else if (/SyntaxError/.test(stderrSnip)) {
            diagnosis = '\n\n**Root cause: syntax error.** Fix the error above and call `webbridge_write_server` again.';
          }

          resolve({
            error: `Process exited with code ${code}.\n\nStderr:\n\`\`\`\n${stderrSnip}\n\`\`\`${diagnosis}`,
          });
        }
      }
    });

    // Kick off the handshake
    setTimeout(() => {
      try { proc.stdin.write(initRequest); } catch (_) {}
    }, 500);
  });
}

// ── Tool: webbridge_install ───────────────────────────────────────────────────

server.tool(
  'webbridge_install',
  {
    site_id: z.string().describe('The site identifier to install'),
    install_method: z.enum(['claude_desktop_config', 'claude_code', 'desktop_extension']).optional().describe(
      '"claude_desktop_config" (default) — writes directly to Claude Desktop\'s config file, ' +
      'pointing at ~/.webbridge/sites/<id>/server/index.js. No packaging needed. ' +
      'Updates take effect on Claude Desktop restart — no reinstall required when server changes. ' +
      '"claude_code" — same but for Claude Code\'s MCP settings. ' +
      '"desktop_extension" — packages everything into a self-contained .mcpb file for sharing or distribution. ' +
      'Requires reinstall each time the server changes. Use this only when distributing to other machines.'
    ),
  },
  async ({ site_id, install_method = 'claude_desktop_config' }) => {
    const stopPing = startProgressPing(server, `install-${Date.now()}`);
    try {
      const siteDir    = path.join(SITES_DIR, site_id);
      const serverDir  = path.join(siteDir, 'server');
      const toolsFile  = path.join(siteDir, 'tools.json');
      const configFile = path.join(siteDir, 'config.json');

      // Validate server exists
      const indexPath = path.join(serverDir, 'index.js');
      if (!fs.existsSync(indexPath)) {
        return {
          content: [{
            type: 'text',
            text: `No server found for ${site_id}. Run webbridge_write_server first, then webbridge_test.`,
          }],
        };
      }

      // Pre-flight: syntax check — block installs of broken servers immediately
      try {
        execSync(`node --check "${indexPath}"`, { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (syntaxErr) {
        const errText = (syntaxErr.stderr || syntaxErr.message || '').slice(0, 600);
        return {
          content: [{
            type: 'text',
            text: [
              `❌ Cannot install: **index.js has a syntax error** that will crash Claude Desktop immediately.`,
              '',
              '```',
              errText,
              '```',
              '',
              'Fix: Regenerate the server with `webbridge_write_server` (using CommonJS `require()` syntax),',
              'then run `webbridge_test` to confirm it starts before retrying `webbridge_install`.',
            ].join('\n'),
          }],
        };
      }

      // Read config and tools
      let config = {};
      try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) {}
      let tools = [];
      try { tools = JSON.parse(fs.readFileSync(toolsFile, 'utf8')); } catch (_) {}

      const results = ['## WebBridge Install\n'];

      // Health check
      if (isNativeHostRunning()) {
        try {
          const health = await callNativeHost({
            type: 'health_request',
            id: `hc_${Date.now()}`,
            domain: config.domain || site_id,
          }, 5000);
          if (health.healthy) {
            results.push(`✅ Chrome extension connected — ${health.tabCount} tab(s) open for ${config.domain}`);
          } else {
            results.push(
              `⚠️ No open tab for ${config.domain}. Open the site in Chrome before using the tools. ` +
              `Auth will fail until a tab is open.`
            );
          }
        } catch (_) {
          results.push(`⚠️ Could not verify Chrome extension health. Make sure the WebBridge extension is running.`);
        }
      } else {
        results.push(`⚠️ Native host not running. Tools will only work when Chrome + WebBridge extension are open.`);
      }

      results.push('');

      if (install_method === 'desktop_extension') {
        await installAsDesktopExtension(site_id, siteDir, serverDir, config, tools, results);
      } else if (install_method === 'claude_desktop_config') {
        installAsClaudeDesktopConfig(site_id, serverDir, config, results);
      } else if (install_method === 'claude_code') {
        installAsClaudeCode(site_id, serverDir, config, results);
      }

      return { content: [{ type: 'text', text: results.join('\n') }] };
    } finally {
      stopPing();
    }
  }
);

async function installAsDesktopExtension(siteId, siteDir, serverDir, config, tools, results) {
  const extDir = path.join(siteDir, 'extension');
  if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });

  // Write manifest.json for the Desktop Extension
  const toolEntries = tools.map((t) => ({
    name: t.name,
    description: t.description,
  }));

  const manifest = {
    $schema: 'https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/dist/mcpb-manifest.schema.json',
    manifest_version: '0.3',
    name: `webbridge-${siteId}`,
    display_name: `WebBridge: ${config.domain || siteId}`,
    version: '1.0.0',
    description: `MCP tools for ${config.domain || siteId}, generated by WebBridge. Requires WebBridge Chrome extension.`,
    author: { name: 'WebBridge (generated)' },
    license: 'MIT',
    keywords: ['webbridge', 'generated', config.domain || siteId],
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js'],
        env: {
          WEBBRIDGE_SITE_ID: siteId,
          WEBBRIDGE_DOMAIN: config.domain || '',
          WEBBRIDGE_AUTH_STRATEGY: config.authStrategy || 'cookie',
        },
      },
    },
    tools: toolEntries,
    user_config: {},
  };

  fs.writeFileSync(
    path.join(extDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  // Copy server directory to extension/server/ (files + node_modules directory)
  const extServerDir = path.join(extDir, 'server');
  if (!fs.existsSync(extServerDir)) fs.mkdirSync(extServerDir);

  // Recursive copy helper
  function copyDirSync(src, dst) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDirSync(s, d);
      else fs.copyFileSync(s, d);
    }
  }

  // Copy only index.js and package.json — then npm install fresh so the .mcpb
  // contains a self-contained, production-only node_modules.
  for (const f of ['index.js', 'package.json']) {
    const src = path.join(serverDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extServerDir, f));
  }

  // npm install inside the extension's server dir so the .mcpb is self-contained
  try {
    execSync('npm install --production --no-audit --no-fund', {
      cwd: extServerDir,
      timeout: 120000,
      encoding: 'utf8',
    });
    results.push('✅ Dependencies installed in extension package');
  } catch (e) {
    results.push(`⚠️ npm install in extension package failed: ${e.message.slice(0, 300)}`);
    results.push('The extension may not work without its dependencies. Check npm output above.');
  }

  // Try to pack with mcpb
  try {
    execSync('npx --yes @anthropic-ai/mcpb pack', {
      cwd: extDir,
      timeout: 60000,
      encoding: 'utf8',
    });
    const mcpbFile = fs.readdirSync(extDir).find((f) => f.endsWith('.mcpb'));
    results.push(`✅ Desktop Extension built: ~/.webbridge/sites/${siteId}/extension/${mcpbFile || '*.mcpb'}`);
    results.push('');
    results.push('**To install in Claude Desktop:**');
    results.push(`1. Open Claude Desktop`);
    results.push(`2. Settings → Extensions → Install from file`);
    results.push(`3. Select: \`~/.webbridge/sites/${siteId}/extension/${mcpbFile || '*.mcpb'}\``);
  } catch (e) {
    results.push(`⚠️ Could not auto-pack (mcpb not available): ${e.message.slice(0, 200)}`);
    results.push('');
    results.push('Extension files written to:');
    results.push(`  ~/.webbridge/sites/${siteId}/extension/`);
    results.push('');
    results.push('To pack manually: `cd ~/.webbridge/sites/' + siteId + '/extension && npx @anthropic-ai/mcpb pack`');
  }
}

function installAsClaudeDesktopConfig(siteId, serverDir, config, results) {
  const configPaths = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
  ];

  const configPath = configPaths.find((p) => fs.existsSync(p)) || configPaths[0];

  let desktopConfig = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try { desktopConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
    if (!desktopConfig.mcpServers) desktopConfig.mcpServers = {};
  }

  const serverKey = `webbridge-${siteId}`;
  desktopConfig.mcpServers[serverKey] = {
    command: 'node',
    args: [path.join(serverDir, 'index.js')],
    env: {
      WEBBRIDGE_SITE_ID: siteId,
      WEBBRIDGE_DOMAIN: config.domain || '',
      WEBBRIDGE_AUTH_STRATEGY: config.authStrategy || 'cookie',
    },
  };

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(desktopConfig, null, 2), 'utf8');

  results.push(`✅ Added "${serverKey}" to: ${configPath}`);
  results.push('');
  results.push('**Restart Claude Desktop** to activate the new tools.');
}

function installAsClaudeCode(siteId, serverDir, config, results) {
  const codeConfigPaths = [
    path.join(os.homedir(), '.config', 'claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];

  const configPath = codeConfigPaths.find((p) => fs.existsSync(p)) || codeConfigPaths[0];

  let codeConfig = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try { codeConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
    if (!codeConfig.mcpServers) codeConfig.mcpServers = {};
  }

  const serverKey = `webbridge-${siteId}`;
  codeConfig.mcpServers[serverKey] = {
    command: 'node',
    args: [path.join(serverDir, 'index.js')],
    env: {
      WEBBRIDGE_SITE_ID: siteId,
      WEBBRIDGE_DOMAIN: config.domain || '',
      WEBBRIDGE_AUTH_STRATEGY: config.authStrategy || 'cookie',
    },
  };

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(codeConfig, null, 2), 'utf8');

  results.push(`✅ Added "${serverKey}" to: ${configPath}`);
  results.push('');
  results.push('**Restart Claude Code** to activate the new tools.');
}

// ── Tool: webbridge_health_check ──────────────────────────────────────────────

server.tool(
  'webbridge_health_check',
  {
    domain: z.string().optional().describe(
      'Domain to check (e.g. "example.com"). If omitted, checks native host connectivity only.'
    ),
  },
  async ({ domain }) => {
    const lines = ['## WebBridge Health Check\n'];

    // 1. Native host socket
    const hostRunning = isNativeHostRunning();
    lines.push(`**Native host socket:** ${hostRunning ? '✅ Running' : '❌ Not running'}`);
    if (!hostRunning) {
      lines.push(`  Socket path: ${SOCKET_PATH}`);
      lines.push('  Make sure the WebBridge Chrome extension is open.');
    }

    if (hostRunning) {
      // 2. Ping the native host
      try {
        const pong = await callNativeHost({ type: 'ping' }, 3000);
        lines.push(`**Native host process:** ✅ PID ${pong.pid}`);
      } catch (e) {
        lines.push(`**Native host process:** ❌ ${e.message}`);
      }

      // 3. Domain-specific tab check
      if (domain) {
        try {
          const health = await callNativeHost({
            type: 'health_request',
            id: `hc_${Date.now()}`,
            domain,
          }, 5000);
          lines.push(`**Chrome tab for ${domain}:** ${health.healthy ? `✅ ${health.tabCount} tab(s) open` : '⚠️ No tab open'}`);
          if (!health.healthy) {
            lines.push(`  Open ${domain} in Chrome and log in to enable auth bridging.`);
          }
        } catch (e) {
          lines.push(`**Chrome tab check:** ❌ ${e.message}`);
        }
      }
    }

    // 4. ~/.webbridge structure
    const dirs = [WEBBRIDGE_DIR, SITES_DIR];
    const dirsOk = dirs.every((d) => fs.existsSync(d));
    lines.push(`**~/.webbridge directory:** ${dirsOk ? '✅ Exists' : '❌ Missing — install the native host first'}`);

    // 5. List sites if any
    if (fs.existsSync(SITES_DIR)) {
      const siteCount = fs.readdirSync(SITES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
      lines.push(`**Configured sites:** ${siteCount}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Tool: webbridge_fetch ─────────────────────────────────────────────────────

server.tool(
  'webbridge_fetch',
  {
    site_id: z.string().describe('The site identifier (used to look up domain and auth strategy)'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method. Default: GET'),
    url: z.string().describe('Full URL to fetch (must be on the same domain as the site)'),
    headers: z.record(z.string()).optional().describe('Additional request headers'),
    body: z.string().optional().describe('Request body as a JSON string or raw string'),
    auth_strategy: z.enum(['cookie', 'bearer', 'apikey', 'in_context_fetch']).optional().describe(
      'Auth strategy override. If omitted, uses the site\'s configured strategy.'
    ),
  },
  async ({ site_id, method = 'GET', url: requestUrl, headers = {}, body, auth_strategy }) => {
    const stopPing = startProgressPing(server, `fetch-${Date.now()}`);
    try {
      // Load site config
      const configFile = path.join(SITES_DIR, site_id, 'config.json');
      let config = { domain: site_id.replace(/_/g, '.'), authStrategy: 'cookie' };
      try { config = { ...config, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch (_) {}

      const domain        = config.domain;
      const strategy      = auth_strategy || config.authStrategy || 'cookie';
      const useInContext  = strategy === 'in_context_fetch';

      const requestSpec = {
        method,
        url: requestUrl,
        headers,
        body: body !== undefined ? body : undefined,
      };

      const resp = await callNativeHost({
        type: 'fetch_request',
        id: `fetch_${Date.now()}`,
        domain,
        authStrategy: useInContext ? 'in_context_fetch' : 'cookie',
        requestSpec,
      }, 30000);

      if (resp.error || resp.sessionExpired) {
        return {
          content: [{
            type: 'text',
            text: `❌ Fetch failed: ${resp.error || 'Session expired'}\n` +
              (resp.sessionExpired ? `Please log into ${domain} in Chrome and try again.` : ''),
          }],
        };
      }

      const response = resp.response;
      let bodyText = response.body || '';
      let formatted = bodyText;

      // Try to pretty-print JSON
      try {
        const parsed = JSON.parse(bodyText);
        formatted = JSON.stringify(parsed, null, 2);
      } catch (_) {}

      if (formatted.length > 8000) formatted = formatted.slice(0, 8000) + '\n... [truncated]';

      return {
        content: [{
          type: 'text',
          text: [
            `## Response: ${method} ${requestUrl}`,
            `**Status:** ${response.status} ${response.statusText}`,
            `**Content-Type:** ${response.headers?.['content-type'] || 'unknown'}`,
            '',
            '```',
            formatted,
            '```',
          ].join('\n'),
        }],
      };

    } finally {
      stopPing();
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write('WebBridge MCP server error: ' + err.message + '\n');
  process.exit(1);
});
