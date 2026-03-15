<p align="center">
  <img src="assets/logo.jpg" width="120" alt="PS4 Vault" style="border-radius:14px"/>
</p>

<h1 align="center">PS4 Vault</h1>

<p align="center">
  <strong>Scan · Organise · Rename · Transfer · Remote Install</strong><br>
  PS4 &amp; PS5 PKG file manager for Windows
</p>

<p align="center">
  <a href="https://github.com/YOUR_GITHUB_USERNAME/ps4-vault/releases/latest"><img src="https://img.shields.io/github/v/release/YOUR_GITHUB_USERNAME/ps4-vault?style=flat-square&color=7c3aed&label=Latest" alt="Latest Release"/></a>
  <a href="https://github.com/YOUR_GITHUB_USERNAME/ps4-vault/releases/latest"><img src="https://img.shields.io/github/downloads/YOUR_GITHUB_USERNAME/ps4-vault/total?style=flat-square&color=2563eb" alt="Downloads"/></a>
  <a href="https://discord.gg/nj45kDSBEd"><img src="https://img.shields.io/discord/YOUR_DISCORD_ID?style=flat-square&color=5865f2&label=Discord" alt="Discord"/></a>
</p>

---

## Features

| Feature | Details |
|---------|---------|
| **Fast local scan** | Reads PKG headers at 512 KB/file — extracts game name, cover, CUSA ID, version, region, FW requirement |
| **FTP scan** | Scan `.pkg` files directly from your PS4/PS5 over FTP |
| **Scan Installed** | Lists every game installed on your console with covers, sizes, and metadata |
| **Remote Install** | Sends PKGs directly to PS4/PS5 — supports **RPI (flatz)** and **etaHEN / GoldHEN** |
| **Real-time progress** | Live speed, ETA, and bytes transferred during install (aggregated across PS5's parallel range connections) |
| **Copy / Move** | Transfer PKGs with live speed + ETA, rename-on-copy, organize by Title ID or Category |
| **Rename** | Batch rename with token-based format strings (`{TITLE}`, `{TITLE_ID}`, `{VERSION}`, …) |
| **Grid + Table views** | Toggle between detailed table and cover-art grid |
| **Auto-update** | Checks GitHub Releases on startup and prompts to download + install |
| **Log file** | Full session log at `%AppData%\PS4Vault\ps4vault.log` for bug reporting |

---

## Requirements

- **Windows 10 / 11** (x64)
- PS4 / PS5 with a jailbreak (GoldHEN, etaHEN, or compatible CFW)
- Remote PKG Installer running on your console for remote installs

---

## Installation

### Installer (recommended — supports auto-update)
1. Download `PS4.Vault-1.3.0-setup.exe` from [Releases](https://github.com/YOUR_GITHUB_USERNAME/ps4-vault/releases/latest)
2. Run the installer — no admin required, installs to your user folder
3. PS4 Vault will notify you when updates are available

### Portable
1. Download `PS4.Vault-1.3.0-portable.exe`
2. Run directly — no installation needed
3. Log file saved to `%AppData%\PS4Vault\ps4vault.log`

> **Note:** The portable version cannot auto-update. Use the installer build for automatic updates.

---

## Remote Install Setup

1. On your PS4/PS5: launch **Remote PKG Installer** (RPI) or ensure **etaHEN / GoldHEN** is active
2. Keep the installer app **in focus** on the console
3. In PS4 Vault: open the install modal, enter your console's IP, click **Test Connection**
4. Select PKGs and click **Send to PS4 / PS5**

PS4 Vault auto-detects whether you're running RPI (flatz) or etaHEN/GoldHEN and uses the correct protocol.

**Network requirements:** Your PC and PS4/PS5 must be on the same network. PS4 Vault automatically configures Windows Firewall to allow inbound connections on the file server port.

---

## Scanning Installed Games

1. Click **🎮 PS4/PS5** → enter your console IP and FTP port (usually `2121`)
2. Click **💾 Scan Installed**

PS4 Vault reads `param.sfo` and `icon0.png` directly from the console filesystem. File sizes are calculated by recursively summing the install directory. Only PS4 titles (`CUSA*`) are shown — PS5 native titles (`PPSA*`) are excluded.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+A` | Select all visible PKGs |
| `Ctrl+F` | Focus search |
| `Enter` | Open install modal for selection |
| `Delete` | Delete selected PKGs |
| `Escape` | Clear selection / close context menu |
| Double-click row | Open install modal |
| Right-click row | Context menu |

---

## Log File

If something goes wrong, the full session log is at:

```
C:\Users\<YourName>\AppData\Roaming\PS4Vault\ps4vault.log
```

Access via **Menu → 📋 View Log File** or **Menu → About PS4 Vault**.

Please include the log when reporting bugs on Discord or GitHub Issues.

---

## Building from Source

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/ps4-vault.git
cd ps4-vault
npm install
npm start              # development
npm run build          # portable .exe
npm run build:installer # NSIS installer .exe
```

---

## Credits

Built by **Nookie**  
Uses [DPI (DirectPackageInstaller)](https://github.com/LightningMods/PS4-Store) protocol for remote install  
[💬 Discord](https://discord.gg/nj45kDSBEd)

---

## Disclaimer

PS4 Vault is a file management tool. It does not include or distribute any copyrighted game files, exploits, or jailbreak software. Use responsibly and only with games you own.
