# Changelog

All notable changes to PS4 Vault are documented here.

---

## [1.3.0] — 2026-03-16

### New Features
- **Auto-update** — PS4 Vault now checks GitHub Releases on startup. A banner appears at the bottom of the screen when an update is available. Click **Download Update** then **Restart & Install** — no manual download required.
- **Scan Installed games** — Lists every PS4 game installed on your console via FTP, with game name (from `param.sfo`), cover art, file size, version, and region. Covers fetched from `/user/appmeta/CUSAXXXXX/icon0.png`. File sizes calculated by recursive FTP directory walk (runs in background, appears as sizes resolve).
- **Log file** — Full session log written to `%AppData%\PS4Vault\ps4vault.log` with 500 KB rotation. Accessible via **Menu → View Log File**. Include this when reporting bugs.
- **"Check for Updates"** added to Menu dropdown.

### Install Improvements
- **etaHEN / GoldHEN support** — Install modal now auto-detects whether your console is running RPI (flatz) or etaHEN/GoldHEN and uses the correct protocol (`POST /api/install` JSON vs `POST /upload` multipart).
- **PS5 parallel range downloads** — PS5 opens 4–8 simultaneous range requests for large PKGs. Progress is now aggregated across all connections for accurate speed and ETA.
- **base64url encoding** — Fixed 404 errors caused by `+` characters in URL parameters when PS5 appended extra query params (`&threadId=0?product=...`).
- **Real-time transfer bar** — Live MB/s, ETA countdown, and bytes transferred during PS4/PS5 download, shown in both the phase bar and per-item row.
- **Phase bar** — Spinning indicator shows current install stage: Connecting → Detecting installer → File server ready → Command accepted → Downloading → Complete.
- **Elapsed timer** — Counts up during install so users know the app is active during slow phases.
- **Cancel during install** — Cancel button now actually cancels the operation mid-install.

### Scan & UI Improvements
- **Inter + JetBrains Mono** — Replaced system font fallback with Inter (UI) and JetBrains Mono (CUSA IDs, paths, version numbers).
- **Themed scrollbars** — Scrollbars now match the dark/light theme.
- **Compact controls row** — Source and destination panels fit in a single row each; more vertical space for game results.
- **Scan complete toast** shows total library size.
- **Go modal title** includes file count: "Moving 3 PKGs…".
- **About modal** — Fixed close button (was not registered due to DOM ordering), fixed logo display.
- **PPSA filter** — PS5 native titles excluded from installed scan; all other PS4 formats (CUSA, PUSA, BLES, BCUS etc.) included.

### Bug Fixes
- Fixed `get-app-path`, `get-local-ip`, `tcpProbe`, `test-ps4-conn` IPC handlers missing after install block refactor.
- Fixed about modal buttons unresponsive (HTML placed after `<script>` tag — DOM elements not yet available when listeners were registered).
- Fixed installed scan showing CUSA IDs instead of game names (SFO found at `/system_data/priv/appmeta/` but icons were searched in wrong path).
- Fixed file size race condition — background `ftpDirSize` results now apply correctly via `pendingUpdates` map.
- Fixed `DefaultInboundAction Allow` firewall setting so Windows port rules apply on Public networks.
- Fixed three separate install commands being sent (content-type retry loop).

---

## [1.2.1] — 2026-03-15

### Features
- Remote install via DPI protocol (RPI + etaHEN)
- PS4/PS5 auto-discovery on local network
- FTP scan of installed games
- Byte-range HTTP file server (fixes SHA digest errors on PS5)
- Copy/Move with live speed + ETA
- Batch rename with format tokens
- Grid and table views
- Cover art hover preview
- Duplicate detection
- Export to CSV
- Context menu (right-click)
- Keyboard shortcuts

### Bug Fixes
- PS5 range requests now served correctly (206 Partial Content)
- base64 URL keys avoid `+` character issues
- FTP port contamination in install modal fixed
- Active scan category resets on new scan

---

## [1.0.0] — Initial Release

- Local folder scan for `.pkg` files
- PKG header parser (extracts CUSA ID, title, cover, version, region, FW from binary)
- Copy / Move / Rename operations
- FTP scan support
- Basic install modal
