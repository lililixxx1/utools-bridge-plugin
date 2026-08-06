# AGENTS.md

Guidance for ZCode agents working in this repository.

## What this is

A **uTools plugin** ("插件手机同步") that bridges uTools' local-only MCP gateway
(`127.0.0.1:3501`, loopback only) to a LAN-accessible HTTP server so a phone on
the same WiFi can read/write uTools **todos, notes, and clipboard** via a PWA —
no app install, one URL, opens in a mobile browser.

The plugin runs inside the uTools desktop app (Electron). There is **no build
step, no package.json, no bundler, no TypeScript, no test/lint config**. All
code is plain JS/HTML loaded directly by uTools. Verify changes by loading the
folder in the uTools developer tool and exercising the feature on a phone.

## Architecture (two-tier — keep these boundaries)

```
preload.js  (Node/CommonJS, runs in uTools plugin process)
  ├─ MCP client  → connects to 127.0.0.1:3501 (session + SSE + reconnect)
  ├─ HTTP server → listens on 0.0.0.0:3721 (auto-tries 3721..3730)
  │   ├─ serves /api/*   → REST, translated to MCP tool calls
  │   └─ serves PWA shell (pwa/ dir) + static files
  └─ exposes window.bridge.* → consumed by index.html control console
index.html   (PC control console UI — config, start/stop, logs)
pwa/         (mobile PWA: index.html inline UI, manifest.json, sw.js)
plugin.json  (uTools manifest — feature code "bridge-open", single-instance)
```

- **`preload.js` is the entire backend.** It does MCP client, HTTP server, REST
  routing, static file serving, auth, and config persistence in one file.
- **`window.bridge`** (defined at the bottom of `preload.js`) is the only bridge
  between the Node layer and `index.html`. New PC-console actions go there.
- **REST routes** live in the `ROUTES` array (preload.js ~L362). Each entry maps
  a `{method, pattern (regex), tool (MCP name), buildArgs}`. To add an endpoint,
  add an entry there. `index:line` is clickable — jump to `ROUTES` to see the
  pattern for the data type you're editing.
- **The PWA (`pwa/index.html`) is self-contained** — inline CSS/JS, talks only
  to `/api/*` via `fetch` with an `x-bridge-key` header. Do not add a build step.

## Conventions

- **Language**: UI text and code comments are in **Chinese**. Match this when
  editing — don't translate existing strings/comments to English.
- **CommonJS** in `preload.js` (`require('node:http')`, etc.). `electron` is
  required lazily and may be absent outside uTools — guard with try/catch.
- **REST response shape** is uniform: `{ ok: true, data } | { ok: false, error }`.
  Always go through `sendJson` / the dispatch helpers; never write raw responses.
- **MCP tool names** are namespaced like `utools.todo.todo_search`,
  `utools.notes.markdown_notes_get`, `utools.clipboard.clipboard_copy`. Check the
  `ROUTES` table for the exact tool a given REST path maps to.
- **IDs contain slashes** (e.g. `todo-tasks/1784162228284`, `note/1763253936619`).
  Route patterns use `(.+)` / `([^/]+)` deliberately to capture the whole id —
  don't "simplify" these to `(\w+)` or ids will be truncated.

## Security-sensitive areas (read before editing)

- **`x-mcp-key`** (uTools per-user MCP gateway key) and **`bridge-key`** (LAN
  access key) are sensitive. They are **never hardcoded** — loaded from
  `dbStorage` at runtime. Defaults are empty; user pastes MCP config in the
  "MCP 配置" card.
- **Device isolation**: these keys are stored under `nativeId()/`-prefixed
  `dbStorage` keys (see `storeKey`/`storeGet` near the top of `preload.js`) so
  they are **not** picked up by uTools cloud sync. Do not move them to plain
  keys. There is a one-time legacy-key migration — preserve it.
- **Auth is ON by default**: on first run a random `bridge-key` is generated and
  persisted ("开箱即鉴权"). Do not change this default — an open bridge exposes
  the clipboard (may contain passwords), notes, and todos to anyone on the LAN.
  Disabling auth is a user-initiated, warned action only.
- **Auth accepts either** `x-bridge-key` header (for fetch) **or** `?key=` query
  param (for browser navigation to the PWA). Both must keep working.
- **Keys returned to the UI are masked** via `maskKey` (first4…last4). Never
  return a full key to the renderer except `regenerateKey`'s one-time plaintext.

## Gotchas

- **PWA service worker cache (`pwa/sw.js`)**: when changing *any* frontend file
  under `pwa/`, you **must bump the `CACHE` version constant** (currently `v8`;
  e.g. `v8`→`v9`) or phones will permanently serve the old cached shell. The SW
  is network-first for the shell, so a bumped version is what forces phones to
  pick up the new `index.html`. The SW intentionally never caches `/api/*`.
  Testing the PWA in ZCode's in-app browser (IAB) hits SW-update timing issues
  — after editing, load with a cache-busting query (`?t=Date.now()`) and/or
  reload twice so the new SW (`skipWaiting`+`claim`) takes over.
- **PWA sticky headers — do NOT set `html, body { height: 100% }`**: that rule
  pins `body` to viewport height while content overflows it, which **breaks
  `header`'s `position: sticky; top: 0`** — the title bar scrolls out of view
  instead of sticking, leaving a gap above the sticky search bar ("下滑后中间
  空了"). Let body height be driven by content. Three sticky elements must all
  keep working: `header` (top:0), `.search-wrap` and `.chips` (top: var(--header-h)).
  Note `.chips`'s own `overflow-x: auto` does *not* break its own sticky (only
  ancestor overflow does), so keep it.
- **PWA search clear must restore the list**: `<input type="search">` renders a
  browser-native clear (×) on the left; clicking it empties the value and fires
  an `input` event but does NOT call the page's search function. The `input`
  handler on `#clipSearch`/`#noteSearch` must, when the value transitions to
  empty, call `loadClipboard()`/`searchNotes()` to restore the full list (see
  the `_hadValue` guard). The custom `#clipClear`/`#noteClear` click handlers
  must also call the restore function (note's historically didn't).
- **MCP session is stateful**: `ensureSession()` does `initialize` → read
  `mcp-session-id` header → `notifications/initialized`. `callTool` auto-retries
  once after clearing the session on 404/400 (handles uTools restart). Preserve
  this reconnect logic.
- **SSE parsing** (`parseSseBody`): responses can contain multiple events
  (progress + result); it matches by JSON-RPC `id` with a fallback. Don't
  replace with a naive "first event" parser.
- **Port range**: server tries 3721, then +1 up to 3730. The actual bound port is
  reported to the UI; don't assume 3721.
- **LAN IP detection** (`getLanIp`, preload.js ~L1174): picks the address shown
  in the console's "访问地址" — a wrong pick means the phone can't reach the PC.
  Three traps to preserve when editing:
  - **Virtual/tunnel NICs are filtered by name** via a regex blacklist
    (VMware/Hyper-V/Docker/WSL/Wintun/TAP/Tailscale/WireGuard/...). VPN and
    proxy tools (e.g. a Rust Wintun tunnel `vgate0`) create NICs with addresses
    like `172.30.x.x` that are unreachable from the phone — if a new VPN tool's
    NIC name slips through, **extend the `VIRTUAL` regex**, don't add special
    cases per IP.
  - **APIPA addresses `169.254.x.x` must be skipped** — that's the no-DHCP
    placeholder; returning it gives a URL that nothing can open.
  - **Do NOT just take `candidates[0]`** by enumeration order. `os.networkInterfaces()`
    ordering is OS-dependent and on Windows frequently puts virtual NICs first.
    Sort: prefer non-/32 masks (real LAN), then by address for stability. The
    /32 case is usually a point-to-point tunnel.
- **Lifecycle**: `utools.onPluginOut(isKill)` stops the server **only** on
  `isKill=true` (process exit). Hiding the plugin keeps the server running so the
  phone stays connected — don't change this to stop on hide.
- **Clipboard image/files byte routes do NOT go through MCP**
  (`handleClipboardByteRoute` in preload.js). The MCP tools
  (`clipboard_history_search`/`_get`/`_copy`) only deal in **PC-local absolute
  paths** for image/files — no bytes, no base64. So three routes do file IO
  directly in the bridge layer: `GET /api/clipboard/:id/blob` (image bytes),
  `GET /api/clipboard/file?id=&path=` (download one file), `POST /api/clipboard/upload`
  (multipart → temp file → `clipboard_copy`). They live in
  `handleClipboardByteRoute`, dispatched **before** the ROUTES table (because
  ROUTES uniformly does `callTool` → JSON; these need raw file streaming).
  Two path-safety gates must be preserved when editing:
  - **`:id/blob`** resolves the item's `image` path and **requires it to be inside
    the uTools clipboard-data dir** (`isPathInside(imgPath, getClipboardDataRoot())`,
    homedir as a loose fallback). Never relax this — otherwise a crafted id
    pointing at a real file becomes an arbitrary-file-read.
  - **`/file`** requires the `path` query param to **exactly equal** one of the
    `files[].path` entries of the item referenced by `id`. Not a prefix match,
    not a substring — `path.resolve()` equality. **Additionally** the matched
    path must pass `isPathInside(target.path, getClipboardDataRoot())` (homedir
    as loose fallback) — same gate as `:id/blob`. The binding alone is not
    sufficient because the `copy` route (`POST /api/clipboard/copy`) passes
    `body.files` verbatim to MCP, so an authenticated caller can plant an
    arbitrary path into a history entry and then "download" it. Both gates must
    stay.
  Upload (`POST /upload`) constraints: 20 MB cap (`MAX_UPLOAD_BYTES`), extension
  blacklist (`UPLOAD_BLOCKED_EXT`, blocks exe/bat/ps1/sh/js/...), basename-only
  filenames, temp file deleted in `finally` (uTools already copied it into its
  own clipboard-data dir). Auth is the same as other `/api/*` (`?key=` or
  `x-bridge-key`); `<img src>` and `<a download>` can't set headers, so the PWA
  builds those URLs with `withKey('/api/...?key=...')`.

## Docs to read before non-trivial changes

- `README.md` — full data-structure reference (todo/notes/clipboard field names;
  note the `text`/`completed` read vs `status:"done"` write asymmetry) and the
  complete REST endpoint table. Read this before touching `ROUTES` or the PWA.
- `PLUGIN_INTRO.md` — marketing copy for the uTools marketplace; update if a
  user-facing capability changes.
