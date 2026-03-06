# WebBridge

_Made with AI_

Turn any website into MCP tools — without writing code, without the site's cooperation, and without a separate desktop app.

Generated servers use the open [Model Context Protocol](https://modelcontextprotocol.io/) standard and work with **any MCP-compatible client** — Claude Desktop, Claude Cowork, Claude Code, Cursor, VS Code (Copilot), Windsurf, Cline, Continue, and more.

> **IMPORTANT DISCLAIMER:** Using WebBridge to interact with websites may violate those websites' Terms of Service, Acceptable Use Policies, or other agreements you have with them. Automated access to websites can result in your IP address being blocked, your account being suspended, or legal action. **You are solely responsible for ensuring your use of WebBridge complies with all applicable terms, laws, and regulations.** The authors of WebBridge accept no liability for misuse. See the [full disclaimer](#disclaimer) below.

---

## How It Works

1. **Record** — Click "Record" in the WebBridge Chrome extension, use the website normally, click "Stop". The extension captures all API traffic using Chrome DevTools Protocol.

2. **Generate** — In Claude Desktop or Claude Code, run `webbridge_read_recordings`. Claude reads the captured traffic, asks you what each action does and what to call it, then writes a fully typed MCP server.

3. **Test** — Call `webbridge_test`. Claude installs dependencies, starts the server, calls each tool, and verifies the responses.

4. **Install** — Call `webbridge_install`. Claude merges the server into your Claude Desktop config — no packaging step required for local use.

5. **Update** — Re-record a changed action, then call `webbridge_update`. Claude diffs new vs. existing recordings and regenerates only the affected tool — no full rewrite needed.

**From recording to working tool: ~10 minutes. No code required.**

---

## Use Cases

### Public Library Search

A WebBridge-generated integration for [York Region public libraries](https://www.bibliocommons.com/) lets Claude search the catalogues of all 9 libraries simultaneously — Aurora, East Gwillimbury, Georgina, King Township, Markham, Newmarket, Richmond Hill, Vaughan, and Whitchurch-Stouffville.

The generated tools:
- `search_york_region_libraries` — Search all 9 catalogues at once, returning results grouped by library with title, author, format, year, and a direct link to the catalogue record
- `search_specific_library` — Search a single library's catalogue with detailed results including call number and description
- `list_york_region_libraries` — List all 9 libraries with their IDs and catalogue URLs

**How it was built:** Record a single catalogue search on BiblioCommons, let Claude analyze the API traffic, generate the MCP server, test, install. The entire process took under 10 minutes with no code written manually.

https://github.com/user-attachments/assets/97b9c6ee-5d11-425a-ac7c-f5aff3ee1102

### Legal Compliance Auditing

Use WebBridge's **Full Dump mode** to capture every network request an application makes — including analytics beacons, third-party calls, and data shared with external services. Then pair the recording with Anthropic's [Legal Knowledge Work Plugin](https://github.com/anthropics/knowledge-work-plugins/tree/main/legal) to have Claude perform compliance analysis:

- **`compliance-check`** — Verify that the data the app actually transmits over the wire matches what the privacy policy and Terms & Conditions claim
- **`review-contract`** — Cross-reference a Data Processing Agreement (DPA) against the observed third-party data sharing

This gives legal and compliance teams a way to audit what an application *does* versus what it *says* it does — grounded in actual network evidence rather than documentation alone.

https://github.com/user-attachments/assets/b4fab281-5f2e-449f-affd-7a314fc802c1

### Privacy & Tracking Audit

Full Dump mode captures every request without filtering — analytics, trackers, fonts, scripts, binary assets, and failed requests. Claude presents a structured privacy report:

- Which third-party domains the site contacts
- What data is sent to analytics/advertising services
- Whether search terms, form values, or PII are leaked to third parties
- Cookie and header analysis per domain
- CDN and infrastructure provider identification

---

## Architecture

```
Chrome (your browser, already running)
|
+-- WebBridge Extension (chrome-extension/)
|   - Records API traffic via chrome.debugger (CDP)
|   - Bridges auth via chrome.cookies + chrome.scripting
|   - Maintains background tabs for in-context-fetch sites
|   - Communicates with native host via native messaging
|
+-- Native Messaging Host (native-host/host.js)
|   - Relays Chrome <-> external processes
|   - Writes recordings to ~/.webbridge/sites/<site-id>/
|   - Exposes Unix socket at ~/.webbridge/bridge.sock
|   - Handles tool management (add/remove) and recording diffs
|
+-- WebBridge MCP Plugin (webbridge-plugin/)
    - Claude reads recordings with webbridge_read_recordings
    - Claude writes server code with webbridge_write_server
    - Claude diffs new recordings with webbridge_update
    - Claude tests with webbridge_test
    - Claude installs with webbridge_install
    - Import HAR files from any browser with webbridge_import_har

Generated MCP Server (per site, in ~/.webbridge/sites/<site-id>/server/)
    - Connects to bridge.sock to make authenticated requests
    - Extracts HTML responses via htmlToText() / @mozilla/readability
    - Installed via claude_desktop_config or packaged as .mcpb
```

---

## Installation

### 1. Load the Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `chrome-extension/` directory

Note the **Extension ID** shown (e.g. `abcdefghijklmnopqrstuvwxyz123456`) — you'll need it in step 2.

**Generate icons first** (optional, needs `npm install canvas`):
```bash
cd chrome-extension/icons
node make-icons.js
```
Or place any 16x16, 48x48, and 128x128 PNGs as `icon16.png`, `icon48.png`, `icon128.png`.

### 2. Install the Native Host

```bash
# Linux
cd native-host
bash install.sh <your-extension-id>

# macOS
cd native-host
bash install-mac.sh <your-extension-id>
```

Reload the extension at `chrome://extensions`. The status dot in the WebBridge popup should turn **green**.

### 3. Install the WebBridge MCP Plugin

```bash
cd webbridge-plugin
npm install
npm run build    # runs: cd server && npm install && npx @anthropic-ai/mcpb pack
```

In Claude Desktop: **Settings -> Extensions -> Install from file** -> select `webbridge-plugin/webbridge.mcpb`

Or manually add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "webbridge": {
      "command": "node",
      "args": ["/path/to/WebBridge/webbridge-plugin/server/index.js"]
    }
  }
}
```

---

## Usage

### Recording Traffic

1. Browse to a site you're logged into
2. Click the **WebBridge icon** in Chrome
3. *(Optional)* Check **Reload page when recording starts** to capture all page-load API calls (like a HAR export)
4. Click **Record**
5. Perform the actions you want to automate (search, fetch data, submit forms)
6. Click **Stop**

The extension saves recordings to `~/.webbridge/sites/<site-id>/recordings/`.

#### Full Dump Mode

Check **Full dump (unfiltered — for privacy/traffic audit)** before recording to capture *every* network request without any filtering — analytics beacons, trackers, fonts, scripts, binary assets, and more. Full dump mode is off by default.

**Use full dump when you want to:**
- Understand how a site tracks you (beacons, fingerprinting)
- Audit what data is sent to third parties
- Investigate privacy or ad-tech behaviour
- Feed network evidence into legal compliance analysis

Full dump recordings are treated differently by Claude: instead of generating MCP tools, Claude presents a structured privacy audit — broken down by domain, with structured cookie values, failed/blocked requests, redirect chains, and SSE frames highlighted.

> **Not** intended for MCP tool generation — use normal recording for that.

#### Importing HAR Files

If you already have a HAR file exported from any browser's DevTools (Chrome, Firefox, Safari, Fiddler), you can import it directly:

```
webbridge_import_har  file_path="/path/to/export.har"  site_id="example_com"
```

This converts the HAR into a WebBridge recording, letting you generate tools from traffic captured outside the extension.

---

### What Gets Recorded

WebBridge captures all the same meaningful fields as a browser HAR export.

| Field | Normal recording | Full dump |
|---|---|---|
| Request method, URL, headers | yes | yes |
| Request body (POST/PUT/PATCH) | yes | yes |
| Response status + headers | yes | yes |
| Response body (text/JSON/HTML) | yes, up to 500 KB | yes, up to 2 MB |
| Binary response bodies | skipped | yes, up to 50 KB |
| Redirect chains (all hops) | yes | yes |
| SSE frames (Server-Sent Events) | yes, up to 4 KB/frame | yes, up to 4 KB/frame |
| WebSocket frames | yes | yes |
| Failed / cancelled requests | no | yes |
| Analytics / tracker requests | filtered out | yes |
| Structured Cookie header parsing | in Claude output | yes, highlighted |
| Timing data | no (not needed for tools) | no |

All redirect hops are captured in order (`redirectChain[]`), so Claude can see the full request flow. SSE streams are captured frame-by-frame (`sseEvents[]`).

---

### Generating Tools

In Claude Desktop:

```
webbridge_list_sites
```
Shows all configured sites and their status.

```
webbridge_read_recordings  site_id="example_com"
```
Claude reads the captured traffic and returns a structured summary.

Then Claude will:
- Identify distinct API operations
- Ask you what to call each tool
- Ask which response fields matter
- Generate `index.js` + `package.json` and write them with `webbridge_write_server`

**Self-validating generation**: after writing the server, `webbridge_write_server` immediately checks for the three most common generation errors before you ever run the code:
1. ESM syntax (`"type": "module"` in package.json) — caught statically
2. Wrong bridge pattern (`http.request` to `localhost`) — caught statically
3. Low-level MCP API (`setRequestHandler`) instead of the `McpServer` + `server.tool()` pattern — caught with a warning

If any check fails, Claude gets a descriptive error and regenerates immediately.

### Updating Tools After Re-recording

If the site changes its API or you want to add a new action:

1. Click **Record** in the popup, perform the new/changed action, click **Stop**
2. Ask Claude to call:
```
webbridge_update  site_id="example_com"
```

Claude receives a **structured diff** — new recording files alongside the existing tool list and current server code — and regenerates only the affected tool(s). The rest of the server stays untouched.

### Testing

```
webbridge_test  site_id="example_com"
```

Claude installs dependencies, starts the server, performs an MCP handshake to list the registered tools, and reports results. If the server crashes on startup, the error output is pattern-matched to diagnose the cause (missing `node_modules`, ESM syntax, wrong bridge URL) and Claude gets a targeted fix suggestion.

### Installing

```
webbridge_install  site_id="example_com"  install_method="claude_desktop_config"
```

Options for `install_method`:
- `claude_desktop_config` *(default)* — merges into `claude_desktop_config.json`; the server runs directly from its directory, no reinstall needed when you edit the server
- `desktop_extension` — builds a `.mcpb` file you can install in Claude Desktop (required for sharing with others)
- `claude_code` — merges into Claude Code settings

> **Tip**: For personal local use, `claude_desktop_config` is simpler — there's no packaging step and changes to the server file take effect immediately after restarting Claude Desktop.

---

## Popup: Site Management

Click the WebBridge icon in Chrome to open the management popup. Each site row is expandable.

### Session Refresh

Inside a site's expanded panel, click **Refresh Session** to open (or focus) an authenticated tab for that domain. The health dot next to the site updates to reflect whether an active tab is present.

### Per-Tool Management

The expanded panel lists every generated tool by name and description. Click **x** next to any tool to remove it from `tools.json`. A regeneration via `webbridge_write_server` is required to apply the change to the running server.

### Background Tab (in-context-fetch sites)

Sites using the `in_context_fetch` auth strategy show a **Background Tab** toggle in the expanded panel. When enabled, WebBridge keeps a hidden tab open for that domain at all times — ensuring the JS session (CSRF tokens, JS-set headers) is always fresh without manual intervention. The tab is silently re-opened if Chrome discards or closes it (checked every 2 minutes via `chrome.alarms`).

---

## Artifact Directory Structure

```
~/.webbridge/
+-- bridge.sock              # Unix socket (native host <-> MCP servers)
+-- host.log                 # Native host log
+-- host.pid                 # Native host process ID
+-- sites/
    +-- example_com/
        +-- config.json          # Domain, auth strategy, bg-tab config, timestamps
        +-- tools.json           # Tool definitions (written after generation)
        +-- recordings/
        |   +-- recording_1234567890.json   # Captured API traffic (normal)
        |   +-- recording_1234567891.json   # fullDump: true recording
        +-- server/
        |   +-- index.js         # Generated MCP server
        |   +-- package.json
        |   +-- node_modules/
        +-- extension/
            +-- manifest.json    # .mcpb manifest
            +-- server/          # Copy of server/ for packaging
            +-- webbridge-example_com.mcpb
```

---

## Auth Strategies

| Strategy | How it works | Best for |
|---|---|---|
| `cookie` | Extension reads cookies via `chrome.cookies.getAll()`, attaches as `Cookie:` header | Most REST APIs with session cookies |
| `in_context_fetch` | Extension runs `fetch()` inside an authenticated tab via `chrome.scripting.executeScript()` | Sites with CSRF tokens, JS-set auth headers |
| `bearer` | Like `cookie`, but auth pattern was detected as Bearer token | OAuth-protected APIs |
| `apikey` | Like `cookie`, but pattern was an API key header | API-key authenticated services |

Auth is auto-detected during recording. Override per-site in the WebBridge popup.

---

## Compatibility

WebBridge generates standard MCP servers that speak JSON-RPC over stdio. They work with **any client that supports the Model Context Protocol** — not just Claude.

### Generation (the WebBridge plugin)

The WebBridge plugin itself (the 10 tools that read recordings, generate code, test, and install) is designed to run in **Claude Desktop** (Cowork mode) or **Claude Code**. The AI needs to be capable enough to analyze API traffic and write a working MCP server from it — Claude is the target for this step.

### Generated servers (the output)

The servers WebBridge produces are **portable**. Once generated, they run anywhere MCP is supported:

| Client | How to connect |
|---|---|
| **Claude Desktop** | `webbridge_install` with `claude_desktop_config` (default) or `.mcpb` extension |
| **Claude Code** | `webbridge_install` with `claude_code`, or add to `.claude/settings.json` |
| **Cursor** | Add to Cursor's MCP config (Settings → MCP → Add Server) |
| **VS Code (Copilot)** | Add to `.vscode/mcp.json` in your workspace |
| **Windsurf** | Add to `~/.codeium/windsurf/mcp_config.json` |
| **Cline / Continue** | Add to the respective MCP settings file |
| **Any MCP client** | Point at the `index.js` with `command: "node"` |

Example config for any client:
```json
{
  "mcpServers": {
    "my-site": {
      "command": "node",
      "args": ["/home/you/.webbridge/sites/my_site/server/index.js"]
    }
  }
}
```

> **Note:** The `.mcpb` packaging format is Claude Desktop-specific. For other clients, point directly at the generated `index.js` — no packaging needed.

---

## MCP Tools Reference

| Tool | Description |
|---|---|
| `webbridge_list_sites` | List all configured sites — IDs, domains, recording counts, tool counts, auth strategies |
| `webbridge_read_recordings` | Read captured API traffic for a site; returns structured request/response data for Claude to analyze |
| `webbridge_write_server` | Write generated MCP server files; runs 3 static validators before saving |
| `webbridge_write_tools_manifest` | Save the final tool definitions to `tools.json` after generation |
| `webbridge_update` | Diff new recordings vs. existing tools; returns targeted change context so Claude regenerates only affected tool(s) |
| `webbridge_test` | Install dependencies and smoke-test a generated server; pattern-matches crash output for targeted diagnosis |
| `webbridge_install` | Install the server via `claude_desktop_config` (default), Desktop Extension, or Claude Code settings |
| `webbridge_health_check` | Verify the Chrome extension is live and the domain has an authenticated tab |
| `webbridge_fetch` | Execute a one-off authenticated request through the bridge for testing/debugging |
| `webbridge_import_har` | Convert a browser-exported HAR file (Chrome DevTools, Firefox, Safari, Fiddler) into a WebBridge recording for tool generation |

---

## FAQ

**Q: Does this store my passwords or session tokens?**
No. The extension reads cookies from your live browser session (which Chrome already has) and forwards them for each request. Nothing is persisted — auth lives entirely in Chrome.

**Q: What happens if I close Chrome?**
The generated tools return a clear error: "WebBridge native host is not running." Reopen Chrome with the extension to restore functionality.

**Q: What if the site changes its API?**
Re-record the affected action in the extension, then call `webbridge_update`. Claude diffs the old and new recordings and updates only the changed tool — no need to regenerate the entire server.

**Q: The background tab toggle — does it slow down my browser?**
The background tab is a minimal hidden tab that stays loaded. Chrome may discard it under memory pressure; WebBridge re-opens it automatically. You can disable the toggle per-site if you prefer to manage tabs manually.

**Q: Can I share my WebBridge integrations?**
Yes. The `.mcpb` files (Claude Desktop Extensions) contain no credentials — only tool definitions, endpoint patterns, and parameter schemas. They're safe to share. For non-Claude clients, share the generated `server/` directory — recipients just run `npm install` and point their MCP client at `index.js`. Either way, recipients need to log into the site themselves in Chrome.

**Q: The yellow "Extension is debugging this browser" bar appeared.**
This only shows during recording when `chrome.debugger` is attached. It disappears when you click Stop. It does not appear during normal tool usage.

**Q: HTML responses look messy — is that expected?**
Generated servers strip HTML tags and decode entities to return readable plain text. SSR sites (Java/Spring, Rails, etc.) return full HTML pages; WebBridge extracts the meaningful text content automatically.

**Q: What is Full Dump mode for?**
Full dump records every network request without filtering — including analytics, trackers, binary resources, and failed requests. It's for privacy audits, traffic analysis, and legal compliance verification, not for building MCP tools. In full dump mode, Claude gives you a structured privacy report instead of generating tools.

**Q: Does WebBridge work in Firefox?**
No. WebBridge relies on `chrome.debugger` (Chrome DevTools Protocol) to capture response bodies — this API is Chrome-only and has no equivalent in Firefox's WebExtension APIs.

**Q: Do I need to reinstall the `.mcpb` every time I update the server?**
Not if you use the `claude_desktop_config` install method (the default). The config points directly at the `index.js` file, so edits take effect immediately after restarting Claude Desktop. Use `desktop_extension` only when you need to share the integration with others.

**Q: I already have a HAR file — do I need to re-record in WebBridge?**
No. Use `webbridge_import_har` to convert any browser-exported HAR file into a WebBridge recording. This works with HAR files from Chrome DevTools, Firefox, Safari, or Fiddler.

---

## Disclaimer

**WebBridge is a tool for personal productivity and research. It is provided "as is" without warranty of any kind.**

By using WebBridge, you acknowledge and agree that:

1. **Terms of Service**: Many websites prohibit automated access, scraping, or interaction with their services outside of their official interfaces. Using WebBridge to interact with such websites may violate their Terms of Service, Acceptable Use Policies, or other legal agreements.

2. **IP and Account Risks**: Automated requests through WebBridge may cause websites to block your IP address, suspend or terminate your account, or take other protective measures.

3. **Legal Compliance**: You are solely responsible for ensuring that your use of WebBridge complies with all applicable laws, regulations, and contractual obligations in your jurisdiction — including but not limited to computer fraud and abuse laws, data protection regulations, and intellectual property rights.

4. **No Endorsement**: The existence of WebBridge does not imply that automated access to any particular website is authorized, legal, or appropriate.

5. **User Responsibility**: The authors and contributors of WebBridge bear no responsibility for any consequences arising from its use, including but not limited to account suspensions, IP bans, legal claims, data loss, or service disruptions.

6. **Generated Tools**: MCP servers generated by WebBridge interact with third-party services. The authors of WebBridge have no control over and accept no responsibility for those services or the consequences of interacting with them.

**Use responsibly and at your own risk.**

---

## License

This project is licensed under the **GNU Affero General Public License v3.0** with the **Commons Clause** license condition.

In short:
- You **may** use, modify, and distribute this software
- Any modifications or derivative works **must** also be released under the same license (AGPL-3.0 + Commons Clause)
- You **may not** sell or commercialize this software or derivative works without explicit written permission from the [Licensor](https://github.com/jalabulajunx)
- If you run a modified version as a network service, you must make the source code available

See the [LICENSE](LICENSE) file for the full text.

For commercial licensing inquiries, contact the [Licensor](https://github.com/jalabulajunx).

---

## Tech Stack

| Layer | Tech |
|---|---|
| Chrome Extension | Manifest V3, `chrome.debugger` (CDP v1.3), `chrome.cookies`, `chrome.scripting`, `chrome.runtime.connectNative`, `chrome.alarms` |
| CDP Events Used | `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, `Network.loadingFailed`, `Network.eventSourceMessageReceived`, `Network.webSocketCreated/FrameSent/FrameReceived` |
| Native Host | Node.js 18+, `net.createServer` (Unix socket), newline-delimited JSON protocol |
| MCP Plugin | `@modelcontextprotocol/sdk`, `zod` |
| Generated Servers | `@modelcontextprotocol/sdk`, `zod`, WebBridge Unix socket bridge client (`net.createConnection`) — works with any MCP client |
| Packaging | `@anthropic-ai/mcpb` (for Desktop Extension distribution) |
