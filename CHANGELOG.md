# What's New in PS4 Vault

---

## Version 1.1.3

### Security / Hardening
- **Saved console/FTP passwords are now encrypted at rest.** Console profiles and the
  last-used password were previously stored in plaintext in `localStorage`. They are now
  encrypted via the OS keystore (Electron `safeStorage`) and decrypted only in memory.
  Existing plaintext entries still load and are re-encrypted on next save; if the OS
  keystore is unavailable it falls back to the old behaviour, so autofill never breaks.
- **Window hardening** — `window.open` is denied, navigation away from the local app is
  blocked, and the renderer now runs with `sandbox: true` (on top of the existing
  `contextIsolation` + strict CSP).
- **CSP tightened** with explicit `object-src 'none'`, `base-uri 'self'`, and
  `frame-ancestors 'none'`.

### Fixed (FTP transfer robustness)
- **A second network install no longer cuts off the first.** The 5-minute post-install
  PKG-server teardown timer is now cancellable and removes only its own firewall rule for
  the exact port — previously a stale timer + wildcard rule deletion could tear down a
  concurrent install's live server and firewall hole.
- **A single dropped upload no longer fails the whole batch.** On an FTP upload failure the
  shared destination connection is reset, so the next file reconnects instead of erroring
  on a dead socket.
- **FTP scan-pool reconnects no longer leak a socket** — a reconnected pool client is now
  tracked so it's closed cleanly, and reconnect failures are logged.

Found by a follow-up concurrency / Electron-hardening audit sweep.

---

## Version 1.1.2

### Security
- **Network PKG install no longer disables the Windows Firewall machine-wide.** It used to
  set `DefaultInboundAction=Allow` on all firewall profiles for every install (restored only
  by a 5-minute timer — closing the app within that window left the machine open). It now
  adds a single scoped inbound rule for the PKG-server port and removes it on teardown.
- **The local PKG server now requires an unguessable per-session token** on every request,
  so another host on the LAN can't pull a queued PKG during the install window.
- **Fixed a renderer XSS.** A malicious FTP server returning a filename containing a double
  quote could break out of an event-handler attribute and inject script (the JS escaper
  didn't escape `"`). Filenames in inline handlers are now JS- *and* attribute-escaped.
- **`delete-pkgs` hardened** — it now refuses any path that isn't an absolute `.pkg`/`.part`
  file (defense-in-depth, matching the existing `rename-pkg` guards).

### Fixed
- **Correct version is shown.** The in-app version was hardcoded and stuck at `1.0.6` while
  the build was `1.1.x`, which also made the auto-updater offer a redundant "update". The
  version is now read from `package.json`, so the title, log, and updater stay in sync.

---

## Version 1.1.1

### CI / Release
- macOS releases now ship **both** Apple Silicon (`-arm64.dmg`) and **Intel (`-x64.dmg`)**
  builds, so Intel Macs are covered.
- Removed the unused "Autobuild Linux & macOS" workflow stub (it ran `make` on every push
  and always failed — it never applied to this Electron app).

No application code changes from v1.1.0.

---

## Version 1.1.0

Brings PS4 Vault up to parity with the hardening done in PS5 Vault.

### Fixed / Changed
- **Covers no longer bloat the library** — game covers are now stored as files in a
  `cover-cache/` folder and referenced by path, instead of being inlined as base64 in
  `library.json`. Existing libraries are migrated automatically on load. On a real
  480-game library this shrank `library.json` from **~242 MB to ~0.3 MB** (≈769× smaller),
  so saves/loads are far faster. Covers still display and persist across restarts, and are
  rehydrated from the cache (or re-read from the PKG) if ever missing.
- **FTP scans no longer come back empty on some consoles** — basic-ftp is forced to use
  `LIST` instead of `MLSD`. Some CFW/payload FTP servers advertise MLST but return an empty
  MLSD listing, so directories looked empty. (Live-tested: a console that returned 0 entries
  via MLSD returns the full listing with `LIST`.)
- **Move can no longer lose a game** — a cross-drive Move now copies, then verifies the
  destination (size + SHA-256, with retry) and only deletes the source after the copy is
  proven good. FTP→Local downloads are rejected if truncated.
- **Different versions are no longer treated as duplicates** — duplicate detection and
  "Delete Duplicates" now key on (content id, version), so two different builds/patches of a
  game are kept distinct and one is never deleted as a duplicate of the other.
- **Auto-updater hardened** — HTTPS-only (rejects http downgrade and off-host redirects),
  downloads into a private per-run temp dir with exclusive create, and cleans up on failure.
- **Library load errors are logged** instead of silently showing an empty library.

---

## Version 1.0.6

### Bug Fixes
- Fixed installed game covers not loading — FTP client was left in a broken state after each failed path attempt, causing all subsequent icon searches to fail silently
- Fixed console profiles not saving — `prompt()` is blocked in Electron, so the name dialog never appeared; replaced with a built-in input dialog
- Fixed console profiles not restoring FTP mode, username, or password on load
- Fixed console modal not remembering username, password, or FTP mode between sessions
- Fixed app getting stuck on splash screen due to a broken JavaScript line left from a previous edit
- Fixed `LIBRARY_FILE` and `SETTINGS_FILE` resolving to empty paths at startup, causing library and settings to not load in the packaged exe
- Removed redundant progress stats from install modal phase bar — speed, ETA and bytes now appear only in the per-game card

### Improvements
- Inter font now bundled locally in the app — no longer depends on Google Fonts, works fully offline
- All emoji removed from buttons, modals, menus and status text throughout the app
- All buttons converted from solid fills to tinted/transparent style
- Game file path removed from library table rows — accessible via the folder button
- Row action buttons replaced with SVG icons (folder only)
- Clicking outside a modal now shakes it instead of closing it — modals only close via their close button
- Save profile button no longer closes the console modal
- All modal close buttons audited and confirmed working
- Removed duplicate progress bar from install modal
- Dead code removed throughout

---

## Version 1.0.5

### Bug Fixes
- Fixed library, settings and recent paths not persisting between sessions in the portable exe
- Fixed app logo not showing in the main UI and About modal when running as a packaged exe
- Fixed console storage bar hardcoded to 500 GB
- Fixed `gdc` category incorrectly appearing as Theme
- Fixed FTP scan retry referencing an undefined variable

### Improvements
- Auto-update uses a direct GitHub Releases check with no external dependencies
- GitHub Actions workflow builds Windows, Mac and Linux on every release tag

---

## Version 1.0.4

### Bug Fixes
- Fixed auto-update not triggering — replaced broken `electron-updater` with a custom GitHub Releases updater
- Fixed library and settings not loading in the portable exe
- Fixed app logo broken in packaged builds

---

## Version 1.0.3

### Bug Fixes
- Fixed auto-update pointing to wrong GitHub repo
- Fixed FTP retry undefined variable
- Fixed `_ftpRetry` persisting across sessions
- Fixed `categoryDisplay` inconsistency between main and renderer

---

## Version 1.0.0 — Initial Release

Scan, organise, rename and transfer PS4/PS5 PKG files. Remote install to console over the network via Remote PKG Installer, GoldHEN or etaHEN.
