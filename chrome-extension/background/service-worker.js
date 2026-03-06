/**
 * WebBridge — Chrome Extension Service Worker
 *
 * Three responsibilities:
 *   1. Traffic Capture (setup)  — CDP via chrome.debugger, saves to native host
 *   2. Auth Bridge (runtime)    — cookie forwarding + in-context fetch
 *   3. Native Messaging relay   — bridges Chrome ↔ native host ↔ MCP servers
 */

'use strict';

const NATIVE_HOST_ID = 'com.webbridge.host';

// ── State ─────────────────────────────────────────────────────────────────────

/** tabId → { siteId, domain, origin, requests: Map<requestId, RecordedRequest> } */
const recordingTabs = new Map();

/** Active native port to the host process */
let nativePort = null;

/** Pending response callbacks for request/response round trips */
const pendingCallbacks = new Map(); // callbackId → { resolve, reject }

// ── Native Messaging ──────────────────────────────────────────────────────────

function connectNative() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_ID);
    nativePort.onMessage.addListener(onNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'disconnected';
      console.warn('[WebBridge] Native host disconnected:', err);
      nativePort = null;
      // Reject any pending callbacks
      for (const [id, cb] of pendingCallbacks) {
        cb.reject(new Error('Native host disconnected: ' + err));
        pendingCallbacks.delete(id);
      }
    });
    console.log('[WebBridge] Native host connected');
  } catch (e) {
    console.warn('[WebBridge] Native host unavailable:', e.message);
    nativePort = null;
  }
}

function ensureNative() {
  if (!nativePort) connectNative();
  return !!nativePort;
}

function sendNative(msg) {
  if (!ensureNative()) {
    console.warn('[WebBridge] Cannot send to native host — not connected');
    return false;
  }
  try {
    nativePort.postMessage(msg);
    return true;
  } catch (e) {
    console.error('[WebBridge] Native send failed:', e.message);
    nativePort = null;
    return false;
  }
}

/**
 * Send a message to the native host and wait for a response with matching id.
 * Used for request/response pairs (e.g., list_sites).
 */
function callNative(msg, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = msg.id || `cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const fullMsg = { ...msg, id };
    const timer = setTimeout(() => {
      pendingCallbacks.delete(id);
      reject(new Error('Native host timeout'));
    }, timeoutMs);
    pendingCallbacks.set(id, {
      resolve: (data) => { clearTimeout(timer); resolve(data); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    if (!sendNative(fullMsg)) {
      clearTimeout(timer);
      pendingCallbacks.delete(id);
      reject(new Error('Native host not connected'));
    }
  });
}

function onNativeMessage(msg) {
  if (!msg) return;

  // Route: response to a pending callback
  if (msg.id && pendingCallbacks.has(msg.id)) {
    const cb = pendingCallbacks.get(msg.id);
    pendingCallbacks.delete(msg.id);
    if (msg.error) cb.reject(new Error(msg.error));
    else cb.resolve(msg);
    return;
  }

  // Route: incoming proxy request from a connected MCP server
  if (msg.type === 'fetch_request') {
    handleFetchRequest(msg).catch(e =>
      sendNative({ type: 'fetch_response', id: msg.id, error: e.message })
    );
    return;
  }

  // Route: cookies request from MCP server
  if (msg.type === 'cookies_request') {
    handleCookiesRequest(msg).catch(e =>
      sendNative({ type: 'cookies_response', id: msg.id, error: e.message })
    );
    return;
  }

  // Route: health check request
  if (msg.type === 'health_request') {
    handleHealthRequest(msg).catch(e =>
      sendNative({ type: 'health_response', id: msg.id, error: e.message })
    );
    return;
  }
}

// ── CDP Traffic Capture ───────────────────────────────────────────────────────

/**
 * Fired by CDP for every network event on a recorded tab.
 * We only store events for tabs we're actively recording.
 */
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (!recordingTabs.has(tabId)) return;
  const rec = recordingTabs.get(tabId);

  switch (method) {

    case 'Network.requestWillBeSent': {
      const { requestId, request, type, documentURL, redirectResponse } = params;

      if (redirectResponse) {
        // ── Redirect hop ────────────────────────────────────────────────────
        // A redirect fires a new requestWillBeSent with the same requestId.
        // We record each hop in redirectChain so the full path is visible,
        // then update the request to reflect the new destination URL.
        const req = rec.requests.get(requestId);
        if (req) {
          if (!req.redirectChain) req.redirectChain = [];
          req.redirectChain.push({
            url: req.url,
            status: redirectResponse.status,
            statusText: redirectResponse.statusText,
            location: redirectResponse.headers?.location || redirectResponse.headers?.Location || null,
          });
          // Update to the new (post-redirect) URL and headers
          req.url = request.url;
          req.requestHeaders = request.headers;
          req.postData = request.postData ?? null;
        }
        break;
      }

      rec.requests.set(requestId, {
        requestId,
        method: request.method,
        url: request.url,
        requestHeaders: request.headers,
        postData: request.postData ?? null,
        resourceType: type,
        documentURL,
        capturedAt: new Date().toISOString(),
        response: null,
        responseBody: null,
        isSSE: false,
        isWebSocket: false,
        failed: false,
        failureText: null,
        redirectChain: null,   // populated above if there are redirect hops
        sseEvents: null,       // populated by Network.eventSourceMessageReceived
        pollChainId: null,
      });
      break;
    }

    case 'Network.responseReceived': {
      const { requestId, response } = params;
      const req = rec.requests.get(requestId);
      if (!req) break;
      req.response = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        mimeType: response.mimeType,
        url: response.url,
      };
      req.isSSE = response.mimeType === 'text/event-stream';
      break;
    }

    case 'Network.loadingFailed': {
      // Covers cancelled fetches, DNS failures, blocked requests, etc.
      const { requestId, errorText, canceled, blockedReason } = params;
      const req = rec.requests.get(requestId);
      if (req) {
        req.failed = true;
        req.failureText = blockedReason
          ? `Blocked (${blockedReason})`
          : canceled ? 'Cancelled'
          : (errorText || 'Failed');
        // Synthesise a minimal response so downstream code can handle it
        if (!req.response) {
          req.response = { status: 0, statusText: req.failureText, headers: {}, mimeType: '' };
        }
      }
      break;
    }

    case 'Network.eventSourceMessageReceived': {
      // SSE data frames — captured for both normal and full-dump recordings.
      // Essential for understanding SSE-based APIs (e.g. streaming AI chat endpoints).
      const { requestId, eventName, eventId, data } = params;
      const req = rec.requests.get(requestId);
      if (req) {
        if (!req.sseEvents) req.sseEvents = [];
        // Truncate individual frame data at 4KB to avoid bloat
        req.sseEvents.push({
          eventName: eventName || 'message',
          eventId: eventId || null,
          data: data.length > 4096 ? data.slice(0, 4096) + '... [truncated]' : data,
        });
      }
      break;
    }

    case 'Network.webSocketCreated': {
      const { requestId, url } = params;
      rec.requests.set(requestId, {
        requestId,
        method: 'WS',
        url,
        requestHeaders: {},
        postData: null,
        resourceType: 'WebSocket',
        documentURL: '',
        capturedAt: new Date().toISOString(),
        response: null,
        responseBody: null,
        isSSE: false,
        isWebSocket: true,
        failed: false,
        failureText: null,
        redirectChain: null,
        sseEvents: null,
        wsFrames: [],
        pollChainId: null,
      });
      break;
    }

    case 'Network.webSocketFrameSent': {
      const req = rec.requests.get(params.requestId);
      if (req?.wsFrames) req.wsFrames.push({ dir: 'sent', payload: params.response.payloadData });
      break;
    }

    case 'Network.webSocketFrameReceived': {
      const req = rec.requests.get(params.requestId);
      if (req?.wsFrames) req.wsFrames.push({ dir: 'received', payload: params.response.payloadData });
      break;
    }

    case 'Network.loadingFinished': {
      const { requestId } = params;
      const req = rec.requests.get(requestId);
      if (!req || !req.response) break;

      const mime = req.response.mimeType || '';
      const isBinary = (
        mime.startsWith('image/') ||
        mime.startsWith('audio/') ||
        mime.startsWith('video/') ||
        mime.startsWith('font/')
      );

      // In full-dump mode: attempt body fetch for small binary responses (tracking pixels
      // etc.) up to 50KB, stored as base64 so Claude can identify 1×1 GIFs.
      // In normal mode: skip binary bodies entirely.
      if (isBinary && !rec.fullDump) break;
      if (mime === 'application/octet-stream' && !rec.fullDump) break;

      // Body size limits: 500KB for normal recording, 2MB for full dump
      const bodySizeLimit = rec.fullDump ? 2 * 1024 * 1024 : 500 * 1024;
      // Binary fetch limit in full dump: 50KB (enough for pixel trackers, not full images)
      const binaryLimit = 50 * 1024;

      try {
        const bodyResult = await new Promise((resolve) => {
          chrome.debugger.sendCommand(
            source,
            'Network.getResponseBody',
            { requestId },
            (result) => resolve(result)
          );
        });
        if (bodyResult) {
          if (bodyResult.base64Encoded) {
            // Binary content — store as base64 in full dump (with size limit), skip in normal
            if (rec.fullDump) {
              const decoded = atob(bodyResult.body);
              req.responseBody = decoded.length > binaryLimit
                ? `[binary ${mime} — ${decoded.length} bytes, body omitted]`
                : `[base64:${bodyResult.body.slice(0, binaryLimit * 1.4)}]`;
              req.responseBinary = true;
            }
          } else {
            req.responseBody = bodyResult.body;
            if (req.responseBody && req.responseBody.length > bodySizeLimit) {
              req.responseBody = req.responseBody.slice(0, bodySizeLimit) + '\n... [truncated]';
            }
          }
        }
      } catch (_) {
        // Body unavailable (streaming, navigated away, etc.) — that's fine
      }
      break;
    }
  }
});

// ── Auth Pattern Detection ────────────────────────────────────────────────────

function detectAuthPattern(requests) {
  for (const req of requests.values()) {
    const auth = req.requestHeaders?.Authorization || req.requestHeaders?.authorization || '';
    if (auth.startsWith('Bearer ')) return 'bearer';
    if (req.requestHeaders?.['X-API-Key'] || req.requestHeaders?.['x-api-key']) return 'apikey';
    if (req.requestHeaders?.['X-Auth-Token'] || req.requestHeaders?.['x-auth-token']) return 'token';
  }
  return 'cookie';
}

function detectSpecialPatterns(requests) {
  const patterns = { hasSSE: false, hasWebSocket: false, hasPollChain: false };
  const postIds = new Set();

  for (const req of requests.values()) {
    if (req.isSSE) patterns.hasSSE = true;
    if (req.isWebSocket) patterns.hasWebSocket = true;

    // Poll chain detection: POST returns an ID, then GETs reference it
    if (req.method === 'POST' && req.responseBody) {
      try {
        const body = JSON.parse(req.responseBody);
        const idField = body.id || body.taskId || body.jobId || body.requestId;
        if (idField) postIds.add(String(idField));
      } catch (_) {}
    }
  }

  if (postIds.size > 0) {
    for (const req of requests.values()) {
      if (req.method === 'GET') {
        for (const id of postIds) {
          if (req.url.includes(id)) {
            patterns.hasPollChain = true;
            req.pollChainId = id;
            break;
          }
        }
      }
    }
  }

  return patterns;
}

// ── Record Start / Stop ───────────────────────────────────────────────────────

async function startRecording(tabId, skipReload = false, fullDump = false) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Cannot record on browser internal pages.');
  }

  const url = new URL(tab.url);
  // Sanitize hostname to a safe filesystem identifier
  const siteId = url.hostname
    .replace(/^www\./, '')
    .replace(/\./g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '');

  // Attach debugger (may already be attached — handle gracefully)
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        // "already attached" is fine — someone else may have DevTools open
        if (chrome.runtime.lastError.message?.includes('already')) resolve();
        else reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });

  // Enable Network domain with generous buffer sizes
  await new Promise((resolve) => {
    chrome.debugger.sendCommand(
      { tabId },
      'Network.enable',
      { maxTotalBufferSize: 20 * 1024 * 1024, maxResourceBufferSize: 5 * 1024 * 1024 },
      resolve
    );
  });

  // Also enable WebSocket frame capture
  await new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Network.setMonitoringXHREnabled', { enabled: true }, resolve);
  });

  recordingTabs.set(tabId, {
    siteId,
    domain: url.hostname,
    origin: url.origin,
    startUrl: tab.url,
    requests: new Map(),
    startedAt: new Date().toISOString(),
    fullDump,
  });

  await chrome.storage.local.set({ [`wb_recording_${tabId}`]: { siteId, domain: url.hostname } });

  // Auto-reload the tab so all page-initialization API calls are captured from scratch.
  // This is the key difference vs HAR: CDP is already attached before the reload fires,
  // so every request the page makes on load — auth checks, data hydration, everything —
  // is recorded. The user doesn't need to do anything special.
  // skipReload is set by the popup's "Don't reload" toggle for stateful flows.
  if (!skipReload) {
    await new Promise((resolve) => chrome.tabs.reload(tabId, { bypassCache: false }, resolve));
  }

  console.log(`[WebBridge] Recording started on tab ${tabId}: ${siteId} (${url.hostname})${skipReload ? ' [no reload]' : ' [reloaded]'}${fullDump ? ' [FULL DUMP]' : ''}`);
  return { success: true, siteId, domain: url.hostname, reloaded: !skipReload, fullDump };
}

async function stopRecording(tabId) {
  const rec = recordingTabs.get(tabId);
  if (!rec) return { success: false, error: 'Not recording on this tab.' };

  // Detach debugger
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });

  recordingTabs.delete(tabId);
  await chrome.storage.local.remove(`wb_recording_${tabId}`);

  const allRequests = [...rec.requests.values()];

  // ── Full dump mode: skip all filtering ────────────────────────────────────────
  // When the user checked "Full dump (unfiltered)", we record every single request
  // including analytics pings, third-party trackers, fonts, scripts — everything.
  // This is useful for privacy audits, understanding tracking, or seeing the full
  // picture of what a site sends. NOT recommended for building MCP tools (too noisy).
  if (rec.fullDump) {
    const authStrategy   = detectAuthPattern(rec.requests);
    const specialPatterns = detectSpecialPatterns(rec.requests);
    const recording = {
      siteId: rec.siteId,
      domain: rec.domain,
      origin: rec.origin,
      startUrl: rec.startUrl,
      authStrategy,
      specialPatterns,
      fullDump: true,
      recordedAt: new Date().toISOString(),
      requestCount: allRequests.length,
      requests: allRequests,
    };
    const recordingName = `recording_${Date.now()}`;
    const sent = sendNative({ type: 'save_recording', siteId: rec.siteId, recordingName, recording });
    console.log(`[WebBridge] Full dump stopped: ${allRequests.length} total requests, sent to native: ${sent}`);
    return {
      success: true,
      siteId: rec.siteId,
      requestCount: allRequests.length,
      fullDump: true,
      authStrategy,
      specialPatterns,
      savedToNative: sent,
    };
  }

  // ── Recording filter ─────────────────────────────────────────────────────────
  // Goal: keep every request that carries application DATA, discard static assets,
  // analytics pings, and known third-party tracking services.
  //
  // Key insight: many sites (especially Java/Spring MVC) are Server-Side Rendered —
  // their data arrives as text/html, not JSON. We must keep those responses while
  // still discarding full-page navigations and analytics pings.

  // Known analytics/tracking URL patterns (same-domain endpoints that log usage)
  const ANALYTICS_URL_RE = [
    /datamartLog/i,
    /[?&]useGdmlLogger=/i,
    /[?&]action=Log\b/i,
    /\/analytics(?:\/|$|\?)/i,
    /\/tracking(?:\/|$|\?)/i,
    /\/beacon(?:\/|$|\?)/i,
    /\/pixel(?:\/|$|\?)/i,
    /\/collect(?:$|\?)/i,
    /\/ping(?:$|\?)/i,
    /\/log(?:Event|Action|Data)(?:\/|$|\?)/i,
    /googletagmanager/i,
    /google-analytics/i,
  ];

  // Known third-party analytics/tracking domains to exclude entirely
  const BLOCKED_DOMAINS = [
    'googletagmanager.com', 'google-analytics.com', 'googleadservices.com',
    'doubleclick.net', 'analytics.google.com',
    'segment.io', 'segment.com',
    'amplitude.com', 'mixpanel.com', 'heap.io',
    'hotjar.com', 'fullstory.com',
    'userway.org', 'acsbapp.com',
    'prismic.io', 'cdn.prismic.io',
    'intercom.io', 'crisp.chat',
    'sentry.io',        // error telemetry
    'bugsnag.com',
  ];

  // Data-identifier parameter names that signal a GET is fetching a specific record,
  // not rendering a layout page.
  const DATA_PARAMS = new Set([
    'id', 'itemid', 'recordid', 'objectid', 'entityid',
    'detailid', 'hl7uniqueid', 'obxid', 'obrId',
    'token', 'key', 'ref',
    'type',  // many SSR sites use ?type=detail to select a data view
  ]);

  const apiRequests = allRequests.filter((r) => {
    if (!r.response && !r.isWebSocket) return false;

    const url  = r.url || '';
    const type = r.resourceType || '';
    const mime = r.response?.mimeType || '';

    // ── 1. CDP resource types that are never data ─────────────────────────────
    // 'Script' and 'Stylesheet' are already caught by mime below, but check type
    // as an early exit for cases where mime isn't set.
    if (['Script', 'Stylesheet', 'Image', 'Font', 'Media'].includes(type)) return false;

    // ── 2. Static-asset mime types ────────────────────────────────────────────
    if (
      mime.startsWith('image/') ||
      mime.startsWith('font/') ||
      mime.startsWith('audio/') ||
      mime.startsWith('video/') ||
      mime.startsWith('application/javascript') ||
      mime.startsWith('text/javascript') ||
      mime.startsWith('application/x-javascript') ||
      mime.startsWith('text/css')
    ) return false;

    // ── 3. Static file path extensions ────────────────────────────────────────
    // Catches JS/CSS fetched via XHR (e.g. jQuery $.get()) regardless of mime.
    try {
      const pathname = new URL(url).pathname;
      if (/\.(js|mjs|cjs|css|woff2?|ttf|eot|otf|svg|png|jpe?g|gif|webp|ico|map)(\?|$)/i.test(pathname)) return false;
    } catch (_) {}

    // ── 4. Analytics/tracking URL patterns ────────────────────────────────────
    if (ANALYTICS_URL_RE.some((re) => re.test(url))) return false;

    // ── 5. Blocked third-party analytics/tracking domains ─────────────────────
    try {
      const hostname = new URL(url).hostname;
      if (BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))) return false;
    } catch (_) {}

    // ── 6. Empty-body GET responses (analytics pings return 0 bytes) ──────────
    if (r.method === 'GET' && !r.isSSE && !r.isWebSocket) {
      if (r.responseBody === null || r.responseBody === '' || r.responseBody === undefined) {
        // Only drop if body is truly empty, not just uncaptured streaming
        if (r.response?.status === 200) return false;
      }
    }

    // ── 7. HTML responses: keep only those carrying application data ──────────
    //
    // Many sites (Java SSR, PHP, Rails with server-rendered partials) deliver
    // data as HTML, not JSON. We keep HTML responses that are clearly data:
    //   • POST → HTML   (form submission returning rendered data)
    //   • *.html path + query params   (server-side data endpoint pattern)
    //   • URL contains UUID or known data-identifier param names
    //
    // We drop plain-page-navigation HTML (GET to root/layout pages).
    if (mime.startsWith('text/html') && !mime.includes('json')) {
      // Always keep POST → HTML (form data submission, server-side rendered result)
      if (r.method === 'POST') return true;

      try {
        const u = new URL(url);

        // Keep .html path endpoints with query params (server-side data partials)
        // e.g. /labresultloader.html?... /getwhatnext.html?... /trend.html?...
        if (u.pathname.endsWith('.html') && u.search.length > 1) return true;

        // Keep GETs that have known data-identifier parameter names
        for (const k of u.searchParams.keys()) {
          if (DATA_PARAMS.has(k.toLowerCase())) return true;
        }

        // Keep GETs where any param value looks like a UUID or long numeric ID
        for (const v of u.searchParams.values()) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
          if (/^\d{6,}$/.test(v)) return true; // long numeric ID
        }
      } catch (_) {}

      // Plain page navigation — drop
      return false;
    }

    // ── 8. Keep everything else (JSON, XHR, Fetch, WebSocket, SSE, XML APIs) ─
    return true;
  });

  const authStrategy = detectAuthPattern(rec.requests);
  const specialPatterns = detectSpecialPatterns(rec.requests);

  // Redact Authorization header values for security — we record the pattern, not the secret
  const redactedRequests = apiRequests.map((r) => {
    const headers = { ...r.requestHeaders };
    if (headers.Authorization || headers.authorization) {
      const auth = headers.Authorization || headers.authorization;
      if (auth.startsWith('Bearer ')) headers.Authorization = 'Bearer [REDACTED]';
      else headers.Authorization = '[REDACTED]';
      delete headers.authorization;
    }
    return { ...r, requestHeaders: headers };
  });

  const recording = {
    siteId: rec.siteId,
    domain: rec.domain,
    origin: rec.origin,
    startUrl: rec.startUrl,
    authStrategy,
    specialPatterns,
    recordedAt: new Date().toISOString(),
    requestCount: redactedRequests.length,
    requests: redactedRequests,
  };

  // Send to native host to persist
  const recordingName = `recording_${Date.now()}`;
  const sent = sendNative({
    type: 'save_recording',
    siteId: rec.siteId,
    recordingName,
    recording,
  });

  console.log(`[WebBridge] Recording stopped: ${redactedRequests.length} API requests, sent to native: ${sent}`);
  return {
    success: true,
    siteId: rec.siteId,
    requestCount: redactedRequests.length,
    authStrategy,
    specialPatterns,
    savedToNative: sent,
  };
}

// ── Auth Bridge: In-Context Fetch ─────────────────────────────────────────────

async function handleFetchRequest(msg) {
  const { id, domain, authStrategy, requestSpec } = msg;
  let response;

  if (authStrategy === 'in_context_fetch') {
    // Find an authenticated tab on the target origin
    const tabs = await chrome.tabs.query({ url: `*://${domain}/*` });

    // Also check for background tabs we manage
    const bgTabKey = `wb_bgtab_${domain}`;
    const stored = await chrome.storage.local.get(bgTabKey);
    let bgTabId = stored[bgTabKey];

    let targetTabId = tabs[0]?.id ?? bgTabId;

    if (!targetTabId) {
      sendNative({
        type: 'fetch_response',
        id,
        error: `No open tab for ${domain}. Open the site in Chrome and log in, then try again.`,
      });
      return;
    }

    // Verify the tab still exists
    try {
      await chrome.tabs.get(targetTabId);
    } catch (_) {
      targetTabId = tabs[0]?.id;
      if (!targetTabId) {
        sendNative({
          type: 'fetch_response',
          id,
          error: `Background tab for ${domain} was closed. Please open the site in Chrome.`,
        });
        return;
      }
    }

    // Execute fetch() inside the authenticated tab context
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: async (spec) => {
        try {
          const opts = {
            method: spec.method || 'GET',
            headers: spec.headers || {},
            credentials: 'include',
          };
          if (spec.body !== undefined && spec.body !== null && spec.method !== 'GET') {
            opts.body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
          }
          const res = await fetch(spec.url, opts);
          const text = await res.text();
          return {
            ok: true,
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(res.headers.entries()),
            body: text,
          };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      args: [requestSpec],
    });

    const result = results[0]?.result;
    if (!result) {
      sendNative({ type: 'fetch_response', id, error: 'Script injection failed' });
      return;
    }
    if (!result.ok) {
      sendNative({ type: 'fetch_response', id, error: result.error });
      return;
    }
    response = { status: result.status, statusText: result.statusText, headers: result.headers, body: result.body };

  } else {
    // Cookie forwarding path: read cookies and attach them to a direct fetch
    const cookies = await chrome.cookies.getAll({ domain });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const fetchHeaders = { ...(requestSpec.headers || {}) };
    if (cookieHeader) fetchHeaders['Cookie'] = cookieHeader;

    const fetchOpts = {
      method: requestSpec.method || 'GET',
      headers: fetchHeaders,
    };
    if (requestSpec.body !== undefined && requestSpec.body !== null && requestSpec.method !== 'GET') {
      fetchOpts.body = typeof requestSpec.body === 'string'
        ? requestSpec.body
        : JSON.stringify(requestSpec.body);
    }

    const res = await fetch(requestSpec.url, fetchOpts);
    const body = await res.text();
    response = {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };
  }

  // Check for session expiry
  if (response.status === 401 || response.status === 403) {
    sendNative({
      type: 'fetch_response',
      id,
      response,
      sessionExpired: true,
      error: `Session expired on ${domain} (HTTP ${response.status}). Please log in again in Chrome.`,
    });
    return;
  }

  sendNative({ type: 'fetch_response', id, response });
}

async function handleCookiesRequest(msg) {
  const { id, domain } = msg;
  const cookies = await chrome.cookies.getAll({ domain });
  sendNative({ type: 'cookies_response', id, cookies });
}

async function handleHealthRequest(msg) {
  const { id, domain } = msg;
  const tabs = await chrome.tabs.query({ url: `*://${domain}/*` });
  sendNative({
    type: 'health_response',
    id,
    healthy: tabs.length > 0,
    tabCount: tabs.length,
    domain,
  });
}

// ── Background Tab Management ─────────────────────────────────────────────────

async function ensureBackgroundTab(domain) {
  const key = `wb_bgtab_${domain}`;
  const stored = await chrome.storage.local.get(key);
  let tabId = stored[key];

  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'unloaded') return tabId;
    } catch (_) {}
  }

  // Create a new background tab
  const tab = await chrome.tabs.create({
    url: `https://${domain}`,
    active: false,
  });
  await chrome.storage.local.set({ [key]: tab.id });
  return tab.id;
}

// ── Popup Message Handler ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    case 'startRecording': {
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        const tabId = tabs[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No active tab.' }); return; }
        startRecording(tabId, msg.skipReload === true, msg.fullDump === true).then(sendResponse).catch((e) =>
          sendResponse({ success: false, error: e.message })
        );
      });
      return true; // async
    }

    case 'stopRecording': {
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        const tabId = tabs[0]?.id;
        if (!tabId) { sendResponse({ success: false, error: 'No active tab.' }); return; }
        stopRecording(tabId).then(sendResponse).catch((e) =>
          sendResponse({ success: false, error: e.message })
        );
      });
      return true;
    }

    case 'getStatus': {
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        const tabId = tabs[0]?.id;
        const rec = tabId ? recordingTabs.get(tabId) : null;
        sendResponse({
          isRecording: !!rec,
          siteId: rec?.siteId ?? null,
          domain: rec?.domain ?? null,
          requestCount: rec ? rec.requests.size : 0,
          nativeConnected: !!nativePort,
        });
      });
      return true;
    }

    case 'listSites': {
      callNative({ type: 'list_sites', id: `ls_${Date.now()}` })
        .then((resp) => sendResponse({ success: true, sites: resp.sites || [] }))
        .catch((e) => sendResponse({ success: false, sites: [], error: e.message }));
      return true;
    }

    case 'getSiteHealth': {
      const { domain } = msg;
      chrome.tabs.query({ url: `*://${domain}/*` }).then((tabs) => {
        sendResponse({ healthy: tabs.length > 0, tabCount: tabs.length });
      });
      return true;
    }

    case 'openArtifactDir': {
      callNative({ type: 'open_artifact_dir', id: `oad_${Date.now()}`, siteId: msg.siteId })
        .then(() => sendResponse({ success: true }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case 'setSiteAuthStrategy': {
      callNative({
        type: 'set_auth_strategy',
        id: `sas_${Date.now()}`,
        siteId: msg.siteId,
        authStrategy: msg.authStrategy,
      }).then(() => sendResponse({ success: true }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case 'ensureBackgroundTab': {
      ensureBackgroundTab(msg.domain)
        .then((tabId) => sendResponse({ success: true, tabId }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    // Phase 5: open or focus an existing tab for a site (Session Refresh)
    case 'openSiteTab': {
      const { origin, domain } = msg;
      chrome.tabs.query({ url: `*://${domain}/*` }).then((tabs) => {
        if (tabs.length > 0) {
          // Focus the existing tab
          chrome.tabs.update(tabs[0].id, { active: true });
          chrome.windows.update(tabs[0].windowId, { focused: true });
          sendResponse({ success: true, focused: true, tabId: tabs[0].id });
        } else {
          // Open a new tab to the site origin so the user can log in
          chrome.tabs.create({ url: origin || `https://${domain}`, active: true }, (tab) => {
            sendResponse({ success: true, focused: false, tabId: tab.id });
          });
        }
      }).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    // Phase 5: remove a single tool from tools.json
    case 'removeTool': {
      callNative({
        type: 'remove_tool',
        id: `rt_${Date.now()}`,
        siteId: msg.siteId,
        toolName: msg.toolName,
      }).then((resp) => sendResponse({ success: resp.success, remaining: resp.remaining }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;
    }

    // Phase 5: get the tools list for one site (for the popup tools section)
    case 'listSiteTools': {
      callNative({
        type: 'list_site_tools',
        id: `lst_${Date.now()}`,
        siteId: msg.siteId,
      }).then((resp) => sendResponse({ success: true, tools: resp.tools || [] }))
        .catch((e) => sendResponse({ success: false, tools: [], error: e.message }));
      return true;
    }

    // Phase 5: toggle background-tab auto-reopen for in-context-fetch sites
    case 'setBackgroundTabConfig': {
      const { siteId, domain, autoReopen } = msg;
      const storageKey = `wb_bgtab_config_${domain}`;
      chrome.storage.local.set({ [storageKey]: { domain, autoReopen } }, () => {
        // Also persist to disk via native host
        callNative({
          type: 'set_bg_tab_config',
          id: `sbtc_${Date.now()}`,
          siteId,
          domain,
          autoReopen,
        }).then(() => sendResponse({ success: true }))
          .catch(() => sendResponse({ success: true })); // non-fatal if native host is down
      });
      return true;
    }
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Clean up any stale recording flags left from a previous service-worker restart
chrome.storage.local.get(null, (items) => {
  const staleKeys = Object.keys(items).filter((k) => k.startsWith('wb_recording_'));
  if (staleKeys.length) chrome.storage.local.remove(staleKeys);
});

// Auto-connect native host
connectNative();

// ── Background Tab Lifecycle (Phase 5) ───────────────────────────────────────
// For sites using in-context-fetch, we maintain background tabs so auth is
// always available. Every 2 minutes we check whether those tabs are still alive
// and reopen them if the user has enabled auto-reopen for that domain.

async function checkBackgroundTabs() {
  let items;
  try { items = await chrome.storage.local.get(null); } catch (_) { return; }

  const bgTabKeys = Object.keys(items).filter((k) => k.startsWith('wb_bgtab_') && !k.startsWith('wb_bgtab_config_'));

  for (const key of bgTabKeys) {
    const domain    = key.slice('wb_bgtab_'.length);
    const tabId     = items[key];
    const configKey = `wb_bgtab_config_${domain}`;
    const cfg       = items[configKey] || {};

    // If auto-reopen is explicitly false, skip
    if (cfg.autoReopen === false) continue;

    let tabExists = false;
    try {
      const tab = await chrome.tabs.get(tabId);
      // If discarded, reload it so scripting works
      if (tab.discarded) {
        await chrome.tabs.reload(tabId);
      }
      tabExists = true;
    } catch (_) {
      tabExists = false;
    }

    if (!tabExists && cfg.autoReopen !== false) {
      // Reopen the background tab
      try {
        const newTab = await chrome.tabs.create({ url: `https://${domain}`, active: false });
        await chrome.storage.local.set({ [key]: newTab.id });
        console.log(`[WebBridge] Reopened background tab for ${domain} (new tabId=${newTab.id})`);
      } catch (e) {
        console.warn(`[WebBridge] Could not reopen background tab for ${domain}:`, e.message);
      }
    }
  }
}

// Periodic heartbeat (every 30s) — keeps native host alive and checks bg tabs
chrome.alarms.create('wb_heartbeat', { periodInMinutes: 0.5 });
// Separate alarm for bg tab health checks (every 2 minutes)
chrome.alarms.create('wb_bgtab_check', { periodInMinutes: 2 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wb_heartbeat') {
    if (!nativePort) connectNative();
  }
  if (alarm.name === 'wb_bgtab_check') {
    checkBackgroundTabs().catch((e) =>
      console.warn('[WebBridge] bg tab check error:', e.message)
    );
  }
});

console.log('[WebBridge] Service worker started');
