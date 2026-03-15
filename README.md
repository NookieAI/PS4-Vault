
# PS4 Vault

**PS4 PKG library manager — scan, organise, rename and transfer `.pkg` files**

PS4 Vault is a desktop application for Windows (portable `.exe`) that helps you manage your PS4 PKG collection. Scan local drives or FTP sources, see game covers and titles extracted directly from each PKG's embedded `param.sfo` and `icon0.png`, then copy, move, rename or send files directly to your PS4 over the network.

---

## Features

- **Scan local drives** — recursively walks any folder or drive letter for `.pkg` files, including mapped network shares
- **Scan all drives at once** — one click discovers every connected drive and scans them all
- **FTP scan** — connect to a PS4's built-in FTP server (or any FTP host) and scan PKGs without downloading them
- **Game covers** — extracts `icon0.png` directly from inside each PKG using the PS4 entry table (`id 0x1200`)
- **Accurate game titles** — reads `param.sfo` (`id 0x1000`) from inside each PKG; falls back to filename parsing then CUSA ID
- **Title quality indicator** — subtle visual cue shows whether the name came from SFO (most reliable), filename heuristic, or fallback
- **Category tabs** — filter by Game / Patch / DLC / App / Theme / Other
- **Sort & search** — sort by title, size, version, region, firmware; live search across title, CUSA ID and filename
- **Rename** — single or batch rename with preset format strings (`{TITLE}`, `{TITLE_ID}`, `{VERSION}`, `{REGION}`, `{CATEGORY}`, `{CONTENT_ID}`, `{REQ_FW}`)
- **Copy / Move** — transfer PKGs with layout options: flat, by Title ID, by Category → ID, rename only, or rename + organise
- **Remote install** — send PKGs directly to your PS4 via [Remote PKG Installer](https://github.com/flatz/ps4_remote_pkg_installer); PS4 downloads from a local HTTP server started by PS4 Vault
- **PS4 auto-discovery** — scans your local `/24` subnet for a PS4 with the installer running
- **Duplicate detection** — flags PKGs sharing the same Content ID
- **Export CSV** — export your full library with all metadata
- **Dark / light theme** — click "Made by Nookie" in the top bar to toggle
- **Portable** — single `.exe`, no installation required

---

## Requirements

- Windows 10 / 11 (x64)
- PS4 on the same local network (for remote install)
- [Remote PKG Installer](https://github.com/flatz/ps4_remote_pkg_installer) on your PS4 (for remote install)

---

## Getting Started

1. Launch `PS4 Vault.exe`
2. Enter or browse to a folder containing `.pkg` files in the **Source** field
3. Click **SCAN** — covers and titles appear as each PKG is parsed
4. Use the category tabs and search bar to filter your library
5. Select PKGs and use the action buttons to rename, copy/move or install

### FTP Scan

1. Click **🌐 FTP Scan**
2. Enter your PS4's IP, port `2121` (or `21`), and the path to scan (e.g. `/data/pkg`)
3. Click **Scan PKGs** — PS4 Vault reads the first 512 KB of each remote PKG to extract metadata without a full download

### Remote Install

1. Select one or more PKGs in the library
2. Click **📡 Install to PS4**
3. Enter your PS4's IP address (or click **🔍 Find PS4** to scan your network)
4. Click **🔌 Test Connection** to verify the Remote PKG Installer is running and in focus on your PS4
5. Click **📡 Send to PS4** — PS4 Vault starts a local HTTP server and instructs your PS4 to download and install each PKG

---

## PKG Parsing

PS4 Vault reads the PKG entry table according to the PS4 PKG specification (confirmed against ShadPS4, PkgToolBox and PS4-PKG-Tool source code):

| Entry ID | File |
|---|---|
| `0x1000` | `param.sfo` — game title, CUSA ID, version, firmware requirement, category |
| `0x1200` | `icon0.png` — cover art |
| `0x1201`–`0x121F` | `icon0` language variants (fallback covers) |

Fallback: if the entry table method fails (re-packed or non-standard PKGs), PS4 Vault scans the first 2 MB and the area around `pkg_body_offset` for the `\x00PSF` magic and PNG/JPEG signatures.

---

## Building

```bash
npm install
npm start          # run in development
npm run build      # build portable .exe → dist/
```

Requires Node.js and npm. Electron and electron-builder are dev dependencies — no other runtime dependencies.

---

## Licence

MIT © 2026 PS4 Vault  
Made by Nookie
