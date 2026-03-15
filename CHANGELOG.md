# Changelog

All notable changes to PS4 Vault are documented here.

---

## [1.1.0] — 2026-03-15

### Fixed — PKG parsing (critical)

**These four bugs prevented covers and accurate game titles from appearing on most PKGs.**

- **`parseSfo` format check was inverted** — the `param_fmt` field in PSF/SFO files is stored big-endian, but the code read it with `readUInt16LE`. This caused the Text format value (`0x0204` BE → `0x0402` LE) to be incorrectly treated as Integer, so every string field (TITLE, CATEGORY, APP_VER) was read back as a raw 32-bit number instead of text. Fixed to check `0x0404` for Integer, everything else as string — matching the PSF spec exactly.

- **Wrong entry count field** — the entry table walk used `readUInt32BE(0x0C)` (`pkg_file_count`) instead of `readUInt32BE(0x10)` (`pkg_table_entry_count`). These differ on many PKGs, causing the walk to stop too early or scan past the table. Fixed to use `0x10`, consistent with ShadPS4, PkgToolBox and PS4-PKG-Tool.

- **Completely wrong entry IDs** — the parser looked for `0x0010` (entry_keys — AES crypto material) and `0x0012` (image_key — PFS encryption key). The correct IDs confirmed by all three reference implementations are `0x1000` (`param.sfo`), `0x1200` (`icon0.png`) and `0x1201`–`0x121F` (icon language variants). Because the SFO magic check always failed against crypto data, every scan fell back to the slow buffer-scan path.

- **Offset interpretation inverted** — entry `offset` values are absolute file offsets. The code tried `pkg_body_offset + entry.offset` first (body-relative), which points to the wrong location for the vast majority of PKGs. Fixed to try the absolute offset first, body-relative only as a fallback for non-standard re-packed PKGs. Both the local and FTP parsers are corrected.

All four fixes applied to both the local file parser and the FTP parser.

### Fixed — SFO title field coverage

- Added `TITLE_00`, `TITLE_02`, `TITLE_03` fallbacks alongside `TITLE` and `TITLE_01` when resolving the game name from SFO data. Many multi-language PS4 PKGs store the primary title under `TITLE_00`.

### Improved — Cover extraction

- `READ_BUF_SIZE` increased from 256 KB to 1 MB so the initial file read captures more of the PKG structure.
- `ICON_MAX_BYTES` increased from 600 KB to 800 KB.
- Fallback icon scan window widened from 1 MB to 4 MB.
- Added a third scan pass centred on `pkg_body_offset` for PKGs with unusually large outer headers.
- Minimum icon data size raised from 16 bytes to 256 bytes to avoid false positives on tiny embedded thumbnails.
- Changed `loading="lazy"` to `loading="eager"` on cover thumbnails — lazy loading in Electron adds no benefit and caused blank covers until a scroll event fired.

### Improved — Title display

- Title cell now uses `sfoTitle` and `fnTitle` as separate explicit fields rather than a combined `title` field with a fragile comparison heuristic. Display priority: SFO title → filename-guessed name → CUSA ID → raw filename.
- Subtle CSS quality classes added (`title-from-sfo`, `title-from-fn`, `title-fallback`) so it is visually apparent how confident the displayed name is.

### Improved — Logo display

- Logo container changed from fixed `48×48` square to `height: 48px; width: auto` so non-square logos render at their natural aspect ratio without cropping.
- `object-fit` changed from `cover` (crop to fill) to `contain` (show whole image).
- SVG fallback updated to a wider `96×48` viewport to match.

### Changed — FTP scan improvements

- `FTP_HDR_SIZE` comment corrected; header read size is 512 KB, enough to cover the entry table, SFO and icon for all standard PKGs without a full download.
- FTP parser now uses correct entry IDs, entry count field and absolute-first offset interpretation — same fixes as the local parser.

---

## [1.0.0] — 2026-01-01

Initial release.

### Features

- Local drive scan with recursive directory walk, up to 10 levels deep
- Parallel PKG parsing (16 workers for local, 4 for network shares)
- FTP scan — connects to PS4 or any FTP server and extracts metadata from the first 512 KB of each remote PKG
- Cover art extraction from `icon0.png` embedded in PKG
- Game title from `param.sfo` embedded in PKG, with filename-based fallback
- Category display: Game, Patch, DLC, App, Theme, Other
- Region detection from Content ID prefix (USA, EUR, JPN, ASIA, KOR)
- Duplicate detection by Content ID
- Sort by title, size, version, region, firmware requirement
- Live search across title, CUSA ID and filename
- Category filter tabs with live counts
- Single and batch rename with format string presets
- Copy / Move with layout options: flat, by Title ID, by Category → ID, rename only, rename + organise
- Conflict detection before transfer with overwrite prompt
- Remote install via Remote PKG Installer (PS4 pulls PKG from local HTTP server)
- PS4 auto-discovery — scans local `/24` subnet on ports 2121, 1337, 12800
- Per-PKG install progress with task polling
- FTP transfer support (copy/move to FTP destination)
- Export library to CSV
- Dark and light theme
- Portable single-file Windows executable (no installation)
